// @vitest-environment jsdom
// Drives the real screens for every deployable instrument in a simulated browser.
import { beforeEach, describe, expect, it } from 'vitest';
import { Survey } from '../src/ui/survey';
import { computeVisibility, indexInstrument } from '../src/engine/logic';
import { deployablePaths, loadInstrument } from './helpers';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});

const click = (el: Element | null) => (el as HTMLElement).click();
const buttonByText = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;

describe.each(deployablePaths())('%s screens', (rel) => {
  const instrument = loadInstrument(rel);
  const idx = indexInstrument(instrument);

  it('shows consent first, then the first section with every visible question', () => {
    const root = document.getElementById('app')!;
    new Survey({ root, instrument, context: 't', preview: true }).render();
    expect(root.textContent).toContain('Before you begin');
    expect(root.querySelector('.question')).toBeNull();
    click(buttonByText('Yes, I agree'));
    const first = instrument.sections[0];
    const vis = computeVisibility(idx, {});
    const expected = first.questions.filter((q) => vis.get(q.id)).map((q) => q.id);
    expect([...root.querySelectorAll('.question')].map((e) => e.getAttribute('data-qid'))).toEqual(expected);
    // Question wording comes straight from the JSON.
    expect(root.querySelector('.q-text')!.textContent).toBe(first.questions[0].text);
  });

  it('blocks Next on unanswered required questions and keeps answers after a reload', () => {
    const root = document.getElementById('app')!;
    new Survey({ root, instrument, context: 't', preview: true }).render();
    click(buttonByText('Yes, I agree'));
    click(buttonByText('Next'));
    const required = instrument.sections[0].questions.filter((q) => q.required && !q.show_if);
    expect(root.querySelectorAll('.has-error').length).toBe(required.length);

    // Answer the first choice question, then "reload": the draft is offered back.
    const radio = root.querySelector('input[type=radio], input[type=checkbox]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    new Survey({ root, instrument, context: 't', preview: true }).render();
    expect(root.textContent).toContain('Welcome back');
    click(buttonByText('Continue where I left off'));
    expect((root.querySelector(`#${radio.id}`) as HTMLInputElement).checked).toBe(true);
  });

  it('keeps nothing when consent is declined', () => {
    const root = document.getElementById('app')!;
    new Survey({ root, instrument, context: 't', preview: true }).render();
    click(buttonByText('No, I do not want to take part'));
    expect(root.textContent).toContain('Nothing has been saved');
    expect(localStorage.length).toBe(0);
  });
});

describe('specify text survives later clicks (regression)', () => {
  it('keeps "Other" text when another option is ticked, and shows it in options_from questions', () => {
    const instrument = loadInstrument('questionnaires/student_11_12/STU_11_12_V1.0.json');
    const root = document.getElementById('app')!;
    const s = new Survey({ root, instrument, context: 't', preview: true });
    // Jump straight to section B as a resumed respondent would.
    (s as unknown as { draft: { consent: string; section_index: number } }).draft.consent = 'yes';
    (s as unknown as { draft: { section_index: number } }).draft.section_index = 1;
    (s as unknown as { screen: string }).screen = 'section';
    s.render();
    const q = (id: string) => root.querySelector(`[data-qid="${id}"]`)!;
    click(q('STU_B02').querySelector('input[value="96"]'));
    const spec = q('STU_B02').querySelector('.specify') as HTMLInputElement;
    spec.value = 'Agriculture';
    spec.dispatchEvent(new Event('input'));
    click(q('STU_B02').querySelector('input[value="1"]'));
    expect((q('STU_B02').querySelector('.specify') as HTMLInputElement).value).toBe('Agriculture');
    const labels = [...q('STU_B06').querySelectorAll('.option-label span')].map((e) => e.textContent);
    expect(labels).toContain('Other (specify): Agriculture');
  });
});
