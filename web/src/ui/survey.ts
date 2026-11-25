// Runs one instrument: resume prompt → consent/assent → one section per screen → finish.
import { t } from '../i18n';
import {
  checkQuestion,
  computeVisibility,
  indexInstrument,
  normalizeAnswers,
  resolveOptions,
  validateSection,
  visibleSections,
  type IndexedInstrument,
  type QuestionCheck,
} from '../engine/logic';
import { buildRecord, wideRow } from '../engine/record';
import { clearDraft, draftKey, loadDraft, moveToOutbox, newDraft, saveDraft, type Draft } from '../storage';
import type { Answer, Instrument } from '../types';
import { h } from './dom';
import { renderQuestion } from './question';

export interface SurveyOptions {
  root: HTMLElement;
  instrument: Instrument;
  /** Separates drafts by entry point, e.g. a school link token hash. */
  context?: string;
  preview: boolean;
  /** Questions the server fills (DEC-24). School links only; never in preview. */
  systemFilled?: string[];
  /** Landing choices on a school link, kept with the response as system fields. */
  route?: { role: 'student' | 'teacher'; class: string };
  /** "Start a new response" on the last screen; default restarts this instrument. */
  onNew?: () => void;
  /** Unfinished drafts older than this (since last change) are discarded, not offered. */
  resumeMaxHours?: number;
  /** "Back" on the first screen (consent / resume), e.g. to the class question. */
  onBack?: () => void;
}

type Screen = 'resume' | 'consent' | 'declined' | 'section' | 'done';

export class Survey {
  private idx: IndexedInstrument;
  private draft: Draft;
  private key: string;
  private screen: Screen;
  private errors = new Map<string, QuestionCheck>();
  private showErrorSummary = false;

  constructor(private opts: SurveyOptions) {
    this.idx = indexInstrument(opts.instrument, { systemFilled: opts.systemFilled });
    this.key = draftKey(opts.instrument.instrument_version_id, opts.context);
    let existing = loadDraft(this.key);
    if (existing && opts.resumeMaxHours !== undefined) {
      const age = Date.now() - Date.parse(existing.updated_at);
      if (!(age >= 0 && age <= opts.resumeMaxHours * 3600_000)) {
        clearDraft(this.key);
        existing = null;
      }
    }
    if (existing && existing.instrument_version_id === opts.instrument.instrument_version_id && !existing.finished_at) {
      this.draft = existing;
      this.screen = Object.keys(existing.answers).length > 0 || existing.consent ? 'resume' : this.firstScreen();
    } else {
      this.draft = this.freshDraft();
      this.screen = this.firstScreen();
    }
  }

  private freshDraft(): Draft {
    const d = newDraft(this.opts.instrument.instrument_version_id);
    if (this.opts.route) {
      d.route_role = this.opts.route.role;
      d.route_class = this.opts.route.class;
    }
    return d;
  }

  private firstScreen(): Screen {
    return this.opts.instrument.settings.consent_required && this.draft.consent !== 'yes' ? 'consent' : 'section';
  }

  private persist(): void {
    saveDraft(this.key, this.draft);
  }

  render(): void {
    const root = this.opts.root;
    root.replaceChildren();
    if (this.opts.preview) root.append(h('div', { class: 'banner', role: 'note' }, t('preview.banner')));
    const main = h('main', { class: 'survey', id: 'main' });
    root.append(main);
    switch (this.screen) {
      case 'resume': return this.renderResume(main);
      case 'consent': return this.renderConsent(main);
      case 'declined': return this.renderDeclined(main);
      case 'section': return this.renderSection(main);
      case 'done': return this.renderDone(main);
    }
  }

  private go(screen: Screen): void {
    this.screen = screen;
    this.render();
    window.scrollTo(0, 0);
    (this.opts.root.querySelector('h1, h2') as HTMLElement | null)?.focus();
  }

  private renderResume(main: HTMLElement): void {
    main.append(
      h('h1', { tabindex: -1 }, t('resume.title')),
      h('p', {}, t('resume.body')),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => this.go(this.firstScreen()) }, t('resume.continue')),
        h('button', {
          type: 'button', class: 'btn', onclick: () => {
            if (!window.confirm(t('resume.restart_confirm'))) return;
            clearDraft(this.key);
            this.draft = this.freshDraft();
            this.go(this.firstScreen());
          },
        }, t('resume.restart')),
      ),
    );
  }

  private renderConsent(main: HTMLElement): void {
    const s = this.opts.instrument.settings;
    const isStudent = this.opts.instrument.respondent_type === 'student';
    main.append(
      h('h1', { tabindex: -1 }, t('consent.title')),
      h('p', { class: 'draft-note' }, t('consent.pending')),
      h('p', {}, t(isStudent ? 'consent.body_student' : 'consent.body_teacher')),
      h('p', {}, t('consent.voluntary')),
      h('p', { class: 'consent-q' }, t(s.assent_required ? 'consent.assent_question' : 'consent.consent_question')),
      h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'btn primary', onclick: () => {
            this.draft.consent = 'yes';
            this.persist();
            this.go('section');
          },
        }, t('consent.yes')),
        h('button', {
          type: 'button', class: 'btn', onclick: () => {
            clearDraft(this.key); // nothing is kept when someone declines
            this.go('declined');
          },
        }, t('consent.no')),
      ),
    );
    if (this.opts.onBack) {
      main.append(h('button', { type: 'button', class: 'link-btn', onclick: () => this.opts.onBack!() }, t('nav.back')));
    }
  }

  private renderDeclined(main: HTMLElement): void {
    main.append(h('h1', { tabindex: -1 }, t('consent.declined_title')), h('p', {}, t('consent.declined_body')));
    if (this.opts.onNew) main.append(h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => this.opts.onNew!() }, t('landing.back_to_start'))));
  }

  private renderSection(main: HTMLElement): void {
    const sections = visibleSections(this.idx, this.draft.answers);
    if (sections.length === 0) return this.go('done');
    const i = Math.min(Math.max(this.draft.section_index, 0), sections.length - 1);
    this.draft.section_index = i;
    const section = sections[i];
    const answers = this.draft.answers;
    const visible = computeVisibility(this.idx, answers);

    const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': sections.length, 'aria-valuenow': i + 1 },
      h('div', { class: 'progress-bar', style: `width:${Math.round(((i + 1) / sections.length) * 100)}%` }));

    const parts = [
      h('p', { class: 'instrument-title' }, this.opts.instrument.title),
      progress,
      h('p', { class: 'section-count' }, t('nav.section_of', { n: i + 1, total: sections.length })),
      h('h2', { tabindex: -1 }, section.title),
      section.notice ? h('p', { class: 'section-notice' }, section.notice) : null,
      this.showErrorSummary && this.errors.size > 0 ? h('p', { class: 'error-summary', role: 'alert' }, t('nav.fix_errors')) : null,
    ];
    for (const p of parts) if (p) main.append(p);

    const form = h('form', { class: 'section', novalidate: true, onsubmit: (e: Event) => e.preventDefault() });
    for (const q of section.questions) {
      if (!visible.get(q.id)) continue;
      const soft = q.type === 'number' ? checkQuestion(this.idx, q, answers, visible).softWarning : false;
      form.append(renderQuestion({
        question: q,
        options: q.type === 'single' || q.type === 'multi' ? resolveOptions(this.idx, q, answers, visible) : q.options ?? [],
        answer: answers[q.id],
        current: () => this.draft.answers[q.id] ?? {},
        check: this.errors.get(q.id),
        softWarning: soft,
        onChoice: (next) => this.update(q.id, next, true),
        onInput: (next) => this.update(q.id, next, false),
      }));
    }
    main.append(form);

    const last = i === sections.length - 1;
    main.append(h('div', { class: 'actions nav' },
      i > 0 ? h('button', { type: 'button', class: 'btn', onclick: () => this.move(-1) }, t('nav.back')) : null,
      h('button', { type: 'button', class: 'btn primary', onclick: () => this.move(1) }, t(last ? 'nav.finish' : 'nav.next')),
    ));
  }

  private update(qid: string, next: Answer, rerender: boolean): void {
    this.draft.answers = normalizeAnswers(this.idx, { ...this.draft.answers, [qid]: next });
    if (this.errors.has(qid)) {
      const q = this.idx.byId.get(qid)!;
      const check = checkQuestion(this.idx, q, this.draft.answers);
      if (!check.error) this.errors.delete(qid);
      rerender = rerender || !check.error;
    }
    this.persist();
    if (rerender) this.rerenderKeepingPosition();
  }

  /** Re-renders the section without losing the scroll position or the focused control. */
  private rerenderKeepingPosition(): void {
    const active = document.activeElement as HTMLElement | null;
    const activeId = active?.id;
    const y = window.scrollY;
    this.render();
    window.scrollTo(0, y);
    if (activeId) (document.getElementById(activeId) as HTMLElement | null)?.focus({ preventScroll: true });
  }

  private move(delta: number): void {
    const sections = visibleSections(this.idx, this.draft.answers);
    const section = sections[this.draft.section_index];
    if (delta > 0) {
      this.errors = validateSection(this.idx, section, this.draft.answers);
      if (this.errors.size > 0) {
        this.showErrorSummary = true;
        this.render();
        const first = this.opts.root.querySelector('.has-error') as HTMLElement | null;
        first?.scrollIntoView({ block: 'start' });
        (first?.querySelector('input, textarea') as HTMLElement | null)?.focus({ preventScroll: true });
        return;
      }
    }
    this.errors.clear();
    this.showErrorSummary = false;
    const nextIndex = this.draft.section_index + delta;
    if (nextIndex >= sections.length) {
      this.draft.finished_at = new Date().toISOString();
      // Preview keeps the draft so the record can be shown; a real response goes to the
      // outbox so the next person on a shared school device starts fresh.
      if (this.opts.preview) this.persist();
      else moveToOutbox(this.key, this.draft);
      return this.go('done');
    }
    this.draft.section_index = Math.max(0, nextIndex);
    this.persist();
    this.go('section');
  }

  private renderDone(main: HTMLElement): void {
    main.append(h('h1', { tabindex: -1 }, t('done.title')), h('p', {}, t(this.opts.preview ? 'done.preview_body' : 'done.body')));
    if (this.opts.preview) {
      const record = buildRecord(this.idx, this.draft.answers);
      const out = {
        submission_id: this.draft.submission_id,
        started_at: this.draft.started_at,
        finished_at: this.draft.finished_at,
        consent: this.draft.consent,
        research_permission: record.research_permission,
        flags: record.flags,
        row: wideRow(this.idx, record),
        restricted: record.restricted,
      };
      main.append(h('pre', { class: 'record' }, JSON.stringify(out, null, 2)));
    }
    main.append(h('div', { class: 'actions' }, h('button', {
      type: 'button', class: 'btn', onclick: () => {
        if (this.opts.preview) clearDraft(this.key);
        if (this.opts.onNew) return this.opts.onNew();
        this.draft = this.freshDraft();
        this.go(this.firstScreen());
      },
    }, t('done.new'))));
  }
}
