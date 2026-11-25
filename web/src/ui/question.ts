// Renders one question from its JSON definition. Every label comes from the instrument;
// only helper text ("Needed", "Select up to 3") comes from the translation file.
import { t } from '../i18n';
import { SPECIFY_MAX_LENGTH, findOption, sameCode, toggleOption, type QuestionCheck } from '../engine/logic';
import type { Answer, Code, Option, Question } from '../types';
import { h } from './dom';

export interface QuestionContext {
  question: Question;
  options: Option[];
  answer: Answer | undefined;
  /** The latest stored answer. Event handlers must use this, not `answer` captured at render. */
  current(): Answer;
  check?: QuestionCheck;
  softWarning?: boolean;
  /** Choice changes re-render the section (visibility and dynamic options may change). */
  onChoice(next: Answer): void;
  /** Typing updates state without re-rendering, so focus is kept. */
  onInput(next: Answer): void;
  notice?: string;
}

const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function renderQuestion(ctx: QuestionContext): HTMLElement {
  const { question: q } = ctx;
  const qid = safeId(q.id);
  const err = ctx.check?.error;
  const errId = `${qid}-err`;

  const meta = h('div', { class: 'q-meta' },
    h('span', { class: q.required ? 'tag tag-req' : 'tag' }, t(q.required ? 'q.required' : 'q.optional')),
    q.type === 'multi' && q.max_select ? h('span', { class: 'q-hint' }, t('q.select_up_to', { max: q.max_select })) : null,
  );

  const body = renderBody(ctx, qid);
  const fs = h('fieldset', {
    class: `question${err ? ' has-error' : ''}`,
    id: `q-${qid}`,
    'data-qid': q.id,
    'aria-describedby': err ? errId : undefined,
    'aria-invalid': err ? 'true' : undefined,
  },
    h('legend', { class: 'q-text' }, q.text),
    meta,
    err ? h('p', { class: 'q-error', id: errId, role: 'alert' }, t(`err.${err.key}`, err.params)) : null,
    ctx.notice ? h('p', { class: 'q-note', role: 'status' }, ctx.notice) : null,
    body,
    ctx.softWarning ? h('p', { class: 'q-note' }, t('q.soft_range')) : null,
  );
  return fs;
}

function renderBody(ctx: QuestionContext, qid: string): HTMLElement {
  const q = ctx.question;
  switch (q.type) {
    case 'single':
    case 'multi':
      return renderChoices(ctx, qid);
    case 'text':
      return renderText(ctx, qid);
    case 'number':
      return renderNumber(ctx, qid);
    case 'matrix':
      return renderMatrix(ctx, qid);
  }
}

function renderChoices(ctx: QuestionContext, qid: string): HTMLElement {
  const q = ctx.question;
  const a = ctx.answer ?? {};
  const codes = a.codes ?? [];
  const list = h('div', { class: 'options' });
  if (ctx.options.length === 0) {
    list.append(h('p', { class: 'q-hint' }, t('q.no_dynamic_options')));
    return list;
  }
  const isMulti = q.type === 'multi';

  for (const o of ctx.options) {
    const selected = codes.some((c) => sameCode(c, o.code));
    const inputId = `${qid}-o-${safeId(String(o.code))}`;
    const input = h('input', {
      type: isMulti ? 'checkbox' : 'radio',
      name: qid,
      id: inputId,
      value: String(o.code),
      checked: selected,
      onchange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked;
        const now = ctx.current();
        const res = toggleOption(q, ctx.options, now.codes ?? [], o.code, checked);
        if (res.refused) {
          (e.target as HTMLInputElement).checked = false;
          showMaxNotice(list, q.max_select!);
          return;
        }
        ctx.onChoice({ ...now, codes: res.codes });
      },
    });
    const row = h('div', { class: `option${selected ? ' selected' : ''}` },
      h('label', { for: inputId, class: 'option-label' }, input, h('span', {}, o.label)),
    );
    if (o.specify && selected) row.append(specifyBox(ctx, a, o.code, inputId));
    list.append(row);
  }

  if (!q.required && codes.length > 0 && !isMulti) {
    list.append(h('button', { type: 'button', class: 'link-btn', onclick: () => ctx.onChoice({ ...ctx.current(), codes: [], specify: {} }) }, t('q.clear')));
  }
  return list;
}

function showMaxNotice(list: HTMLElement, max: number): void {
  let n = list.querySelector('.max-notice');
  if (!n) {
    n = h('p', { class: 'q-note max-notice', role: 'status' });
    list.prepend(n);
  }
  n.textContent = t('q.max_reached', { max });
}

function specifyBox(ctx: QuestionContext, a: Answer, code: Code, inputId: string): HTMLElement {
  const key = String(code);
  return h('input', {
    type: 'text',
    class: 'specify',
    id: `${inputId}-specify`,
    'aria-label': t('q.specify'),
    placeholder: t('q.specify'),
    maxlength: SPECIFY_MAX_LENGTH,
    value: a.specify?.[key] ?? '',
    oninput: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      const now = ctx.current();
      ctx.onInput({ ...now, specify: { ...(now.specify ?? {}), [key]: v } });
    },
    // On leaving the box, redraw so questions that reuse this answer (options_from) show the text.
    onchange: () => ctx.onChoice(ctx.current()),
  });
}

function renderText(ctx: QuestionContext, qid: string): HTMLElement {
  const a = ctx.answer ?? {};
  const max = ctx.question.max_length;
  const counter = max ? h('p', { class: 'q-hint counter' }, t('q.chars_left', { n: max - (a.text?.length ?? 0) })) : null;
  const ta = h('textarea', {
    id: `${qid}-text`,
    rows: 3,
    maxlength: max,
    placeholder: t('q.text_placeholder'),
    oninput: (e: Event) => {
      const v = (e.target as HTMLTextAreaElement).value;
      if (counter && max) counter.textContent = t('q.chars_left', { n: max - v.length });
      ctx.onInput({ ...ctx.current(), text: v });
    },
  });
  ta.value = a.text ?? '';
  return h('div', { class: 'text-answer' }, ta, counter);
}

function renderNumber(ctx: QuestionContext, qid: string): HTMLElement {
  const a = ctx.answer ?? {};
  const v = ctx.question.validation ?? {};
  return h('input', {
    type: 'text',
    inputmode: v.integer ? 'numeric' : 'decimal',
    id: `${qid}-num`,
    class: 'number',
    autocomplete: 'off',
    placeholder: t('q.number_placeholder'),
    value: a.num ?? '',
    oninput: (e: Event) => ctx.onInput({ ...ctx.current(), num: (e.target as HTMLInputElement).value }),
    onchange: (e: Event) => ctx.onChoice({ ...ctx.current(), num: (e.target as HTMLInputElement).value }),
  });
}

function renderMatrix(ctx: QuestionContext, qid: string): HTMLElement {
  const q = ctx.question;
  const a = ctx.answer ?? {};
  const options = q.options ?? [];
  const wrap = h('div', { class: 'matrix' });
  for (const r of q.rows ?? []) {
    const name = `${qid}-${safeId(r.variable)}`;
    const current = a.rows?.[r.variable];
    const group = h('div', { class: 'matrix-row', role: 'radiogroup', 'aria-label': r.label },
      h('p', { class: 'matrix-label' }, r.label));
    const opts = h('div', { class: 'options' });
    for (const o of options) {
      const id = `${name}-o-${safeId(String(o.code))}`;
      const selected = current !== undefined && sameCode(current, o.code);
      opts.append(h('div', { class: `option${selected ? ' selected' : ''}` },
        h('label', { for: id, class: 'option-label' },
          h('input', {
            type: 'radio', name, id, value: String(o.code), checked: selected,
            onchange: () => {
              const now = ctx.current();
              ctx.onChoice({ ...now, rows: { ...(now.rows ?? {}), [r.variable]: findOption(options, o.code)!.code } });
            },
          }),
          h('span', {}, o.label))));
    }
    group.append(opts);
    wrap.append(group);
  }
  return wrap;
}
