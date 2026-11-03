import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { createFakes, settle } from '../../testing/fakes';
import { Icon } from '../shared/icon';
import { CurrentFolder } from '../workspace/current-folder';
import { EditorArea } from './editor-area';
import { EditorTabs } from './editor-tabs';

describe('EditorArea', () => {
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it('rola a faixa até a aba ativa sempre que ela muda, só o necessário', async () => {
    const fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
    // Sem o Monaco: o editor não importa aqui, só a faixa de abas.
    TestBed.overrideComponent(EditorArea, {
      set: { imports: [Icon], schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
    TestBed.inject(CurrentFolder).path.set('C:\\proj');
    for (const name of ['a', 'b', 'c']) fakes.files.write(`C:\\proj\\${name}.cpp`, '');
    // O jsdom não implementa a rolagem.
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element, options) {
      expect(options).toEqual({ block: 'nearest', inline: 'nearest' });
      scrolled.push(this.getAttribute('title')!);
    });
    const fixture = TestBed.createComponent(EditorArea);
    const tabs = TestBed.inject(EditorTabs);

    for (const name of ['a', 'b', 'c']) await tabs.open(`C:\\proj\\${name}.cpp`);
    await fixture.whenStable();
    tabs.activate(tabs.tabs()[0]);
    await settle();
    await fixture.whenStable();

    expect(scrolled.at(-1)).toBe('C:\\proj\\a.cpp');
    expect(scrolled).toContain('C:\\proj\\c.cpp');
  });
});
