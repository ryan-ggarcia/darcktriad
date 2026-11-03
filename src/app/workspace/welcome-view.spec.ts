import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { Workspace } from './workspace';
import { formatLastOpened, WelcomeView } from './welcome-view';

describe('tela inicial', () => {
  describe('data das recentes', () => {
    const now = new Date(2026, 9, 30, 18, 5);
    const at = (...parts: [number, number, number, number, number]) => new Date(...parts).getTime();

    it('hoje, ontem e, antes disso, a data completa, na hora local', () => {
      expect(formatLastOpened(at(2026, 9, 30, 14, 32), now)).toBe('hoje, 14:32');
      expect(formatLastOpened(at(2026, 9, 29, 9, 15), now)).toBe('ontem, 09:15');
      expect(formatLastOpened(at(2026, 9, 28, 9, 15), now)).toBe('28/10/2026 09:15');
      expect(formatLastOpened(at(2025, 11, 31, 23, 59), now)).toBe('31/12/2025 23:59');
    });

    it('conta pelo dia do calendário, não por 24 horas', () => {
      const justAfterMidnight = new Date(2026, 9, 30, 0, 1);
      expect(formatLastOpened(at(2026, 9, 29, 23, 59), justAfterMidnight)).toBe('ontem, 23:59');
      expect(formatLastOpened(at(2026, 9, 30, 0, 0), justAfterMidnight)).toBe('hoje, 00:00');
    });

    it('sem data (gravadas antes da v0.8.2): nada', () => {
      expect(formatLastOpened(null, now)).toBe('');
    });
  });

  describe('na tela', () => {
    let fakes: Fakes;

    async function render(): Promise<HTMLElement> {
      fakes = createFakes();
      fakes.workspace.recents = [
        { path: 'C:\\proj', exists: true, lastOpened: Date.now() },
        { path: 'C:\\velha', exists: false, lastOpened: null },
      ];
      TestBed.configureTestingModule({ providers: fakes.providers });
      const fixture = TestBed.createComponent(WelcomeView);
      await TestBed.inject(Workspace).start();
      await settle();
      await fixture.whenStable();
      return fixture.nativeElement as HTMLElement;
    }

    it('cada recente mostra nome, caminho e data; sem data, só nome e caminho', async () => {
      const page = await render();

      const [proj, old] = page.querySelectorAll('.recent');
      expect(proj.querySelector('.recent-name')?.textContent).toBe('proj');
      expect(proj.querySelector('.recent-path')?.textContent).toBe('C:\\proj');
      expect(proj.querySelector('.recent-date')?.textContent).toMatch(/^hoje, \d\d:\d\d$/);
      expect(old.querySelector('.recent-date')).toBeNull();
    });

    it('"Remover da lista" tira a pasta das recentes pelo núcleo', async () => {
      const page = await render();

      page.querySelector<HTMLButtonElement>('[aria-label="Opções de proj"]')!.click();
      await settle();
      TestBed.tick();
      const remove = [...page.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find((item) =>
        item.textContent?.includes('Remover da lista'),
      )!;
      remove.click();
      await settle();
      TestBed.tick();

      expect(fakes.workspace.removedRecents).toEqual(['C:\\proj']);
      expect([...page.querySelectorAll('.recent-name')].map((name) => name.textContent)).toEqual([
        'velha',
      ]);
    });

    it('Executar projeto fica indisponível, com a explicação, sem projeto aberto', async () => {
      const page = await render();

      const run = [...page.querySelectorAll<HTMLButtonElement>('.welcome-card')].at(-1)!;
      expect(run.getAttribute('aria-disabled')).toBe('true');
      expect(run.title).toContain('abra uma pasta com CMakeLists.txt');
    });
  });
});
