import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { Appearance } from '../shared/appearance';
import { Commands } from '../shared/commands';
import { TitleBar } from './title-bar';

describe('TitleBar', () => {
  let fakes: Fakes;

  beforeEach(() => {
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
  });

  async function render(): Promise<HTMLElement> {
    const fixture = TestBed.createComponent(TitleBar);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  it('os botões da janela chamam a API; o ✕ pede para fechar (e passa pela pergunta)', async () => {
    const page = await render();
    const button = (label: string) =>
      page.querySelector<HTMLButtonElement>(`.window-button[aria-label="${label}"]`);

    button('Minimizar')!.click();
    button('Maximizar')!.click();
    await settle();
    await frame();
    await settle();
    TestBed.tick();
    // Maximizada, o mesmo botão restaura.
    expect(button('Maximizar')).toBeNull();
    button('Restaurar')!.click();
    button('Fechar')!.click();

    expect(fakes.window.calls).toEqual(['minimize', 'toggleMaximize', 'toggleMaximize', 'close']);
  });

  it('a área vazia arrasta a janela; menus e botões não', async () => {
    const page = await render();

    expect(page.getAttribute('data-tauri-drag-region')).toBe('deep');
    expect(page.querySelector('app-menu-bar')?.getAttribute('data-tauri-drag-region')).toBe(
      'false',
    );
  });

  it('a busca abre o Abrir rápido e o botão de tema alterna escuro e claro', async () => {
    const page = await render();
    const run = vi.spyOn(TestBed.inject(Commands), 'run');

    page.querySelector<HTMLButtonElement>('.title-search')!.click();
    expect(run).toHaveBeenCalledWith('quickOpen');
    expect(page.querySelector('.title-search')?.textContent).toContain('Ctrl+P');

    const theme = page.querySelector<HTMLButtonElement>('[aria-label="Mudar para o tema claro"]')!;
    theme.click();
    TestBed.tick();
    expect(TestBed.inject(Appearance).theme()).toBe('light');
    expect(theme.getAttribute('aria-label')).toBe('Mudar para o tema escuro');
    localStorage.clear();
  });
});
