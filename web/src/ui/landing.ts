// School link landing (docs/22 §3): "Student or teacher?" → class → the right survey.
// The page never shows the school's name or any school detail (DEC-23): it only knows
// what school_info returns (status, classes, instrument versions).
import { t } from '../i18n';
import { classChoices, rolesFor, type ClassChoice, type IndexEntry, type Role, type SchoolInfo } from '../routing';
import type { Instrument } from '../types';
import { h } from './dom';
import { Survey } from './survey';

/** An unfinished answer set on a school link can be resumed for this long (DEC-27). */
export const SCHOOL_RESUME_MAX_HOURS = 6;

export interface LandingOptions {
  root: HTMLElement;
  index: IndexEntry[];
  info: SchoolInfo;
  /** Local storage namespace for this school link (a hash of the token, never the token). */
  context: string;
  offline: boolean;
  loadInstrument(entry: IndexEntry): Promise<Instrument>;
}

export class Landing {
  constructor(private opts: LandingOptions) {}

  start(): void {
    const { info } = this.opts;
    if (info.status !== 'active') return this.closed(info.status);
    const roles = rolesFor(this.opts.index, info);
    if (roles.length === 0) return this.closed('unavailable');
    if (roles.length === 1) return this.chooseClass(roles[0], false);
    this.chooseRole(roles);
  }

  private screen(...children: (Node | null)[]): HTMLElement {
    const main = h('main', { class: 'survey', id: 'main' });
    if (this.opts.offline) main.append(h('p', { class: 'q-note', role: 'status' }, t('landing.offline')));
    for (const c of children) if (c) main.append(c);
    this.opts.root.replaceChildren(main);
    window.scrollTo(0, 0);
    (main.querySelector('h1') as HTMLElement | null)?.focus();
    return main;
  }

  private closed(status: SchoolInfo['status']): void {
    const key = status === 'not_yet_open' ? 'not_yet_open' : status === 'closed' ? 'closed' : 'unavailable';
    this.screen(h('h1', { tabindex: -1 }, t(`landing.${key}_title`)), h('p', {}, t(`landing.${key}_body`)));
  }

  private chooseRole(roles: Role[]): void {
    const list = h('div', { class: 'choice-list' });
    for (const r of roles) {
      list.append(h('button', { type: 'button', class: 'btn choice', 'data-role': r, onclick: () => this.chooseClass(r, true) }, t(`landing.role_${r}`)));
    }
    this.screen(
      h('h1', { tabindex: -1 }, t('landing.title')),
      h('p', {}, t('landing.intro')),
      h('h2', {}, t('landing.role_question')),
      list,
    );
  }

  private chooseClass(role: Role, canGoBack: boolean): void {
    const choices = classChoices(this.opts.index, this.opts.info, role);
    const list = h('div', { class: role === 'student' ? 'choice-grid' : 'choice-list' });
    for (const c of choices) {
      const label = role === 'student'
        ? t('landing.class_option', { n: c.value })
        : t('landing.band_option', { from: c.classes[0], to: c.classes[c.classes.length - 1] });
      list.append(h('button', { type: 'button', class: 'btn choice', 'data-class': c.value, onclick: () => this.open(role, c) }, label));
    }
    this.screen(
      h('h1', { tabindex: -1 }, t(role === 'student' ? 'landing.class_question_student' : 'landing.class_question_teacher')),
      role === 'teacher' && choices.length > 1 ? h('p', { class: 'q-hint' }, t('landing.teacher_both')) : null,
      list,
      canGoBack ? h('button', { type: 'button', class: 'link-btn', onclick: () => this.start() }, t('nav.back')) : null,
    );
  }

  private async open(role: Role, choice: ClassChoice): Promise<void> {
    this.screen(h('p', {}, t('app.loading')));
    try {
      const instrument = await this.opts.loadInstrument(choice.instrument);
      new Survey({
        root: this.opts.root,
        instrument,
        // One draft per school link and route. Old unfinished drafts are dropped
        // (resumeMaxHours) so the next person on a shared device does not see them.
        context: `${this.opts.context}.${role}.${choice.value}`,
        preview: false,
        systemFilled: Object.keys(choice.instrument.system_fill ?? {}),
        route: { role, class: choice.value },
        resumeMaxHours: SCHOOL_RESUME_MAX_HOURS,
        onNew: () => this.start(),
        onBack: () => this.chooseClass(role, rolesFor(this.opts.index, this.opts.info).length > 1),
      }).render();
    } catch {
      const main = this.screen(h('p', { role: 'alert' }, t('app.load_failed')));
      main.append(h('button', { type: 'button', class: 'btn primary', onclick: () => this.open(role, choice) }, t('app.retry')));
    }
  }
}
