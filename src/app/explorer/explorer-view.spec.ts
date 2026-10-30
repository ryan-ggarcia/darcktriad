import { ComponentFixture, TestBed } from '@angular/core/testing';
import { createFakes, settle } from '../../testing/fakes';
import { CurrentFolder } from '../workspace/current-folder';
import { ExplorerTree } from './explorer-tree';
import { ExplorerView } from './explorer-view';

const ROOT = 'C:\\grande';
const MANY = 'C:\\grande\\muitos';
const COUNT = 5000;
/** Meta do README: expandir 5.000 itens em < 300 ms. Aqui sem o IPC, que o cargo test mede. */
const EXPAND_BUDGET_MS = 300;
/**
 * Cada passo de rolagem troca todas as linhas desenhadas. No jsdom isso leva ~10 ms, bem mais que
 * no WebView (o quadro real é medido no app); sem a virtualização, levaria segundos.
 */
const SCROLL_STEP_BUDGET_MS = 50;

describe('ExplorerView com o projeto grande', () => {
  let fixture: ComponentFixture<ExplorerView>;
  let page: HTMLElement;
  let viewport: HTMLElement;

  const rows = () => [...page.querySelectorAll<HTMLElement>('[role=treeitem]')];
  const names = () => rows().map((row) => row.querySelector('.tree-name')?.textContent);

  beforeAll(() => {
    // O jsdom não tem ResizeObserver; a árvore só o usa para medir a altura visível.
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(async () => {
    const fakes = createFakes();
    const files = Array.from({ length: COUNT }, (_, i) => `${MANY}\\arquivo${i}.cpp`);
    fakes.explorer.add(`${MANY}\\`, ...files);
    TestBed.configureTestingModule({ providers: fakes.providers });
    TestBed.inject(CurrentFolder).path.set(ROOT);
    await TestBed.inject(ExplorerTree).refresh();
    fixture = TestBed.createComponent(ExplorerView);
    page = fixture.nativeElement as HTMLElement;
    await render();
    viewport = page.querySelector<HTMLElement>('[role=tree]')!;
  });

  async function render(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  it('expande a pasta de 5.000 itens dentro da meta e desenha só as linhas visíveis', async () => {
    const start = performance.now();
    rows()[0].click();
    await render();
    const elapsed = performance.now() - start;

    expect(names().slice(0, 2)).toEqual(['muitos', 'arquivo0.cpp']);
    expect(rows().length).toBeLessThan(100);
    expect(elapsed).toBeLessThan(EXPAND_BUDGET_MS);
  });

  it('cada passo de rolagem redesenha só as linhas visíveis, e as certas', async () => {
    rows()[0].click();
    await render();

    const steps: number[] = [];
    for (let row = 0; row < COUNT; row += 50) {
      Object.defineProperty(viewport, 'scrollTop', { value: row * 22, configurable: true });
      const start = performance.now();
      viewport.dispatchEvent(new Event('scroll'));
      fixture.detectChanges();
      steps.push(performance.now() - start);
    }
    steps.sort((a, b) => a - b);
    const p95 = steps[Math.floor(steps.length * 0.95)];

    // Na linha 4.950 a pasta `muitos` é a linha 0, então `arquivo4949.cpp` está no topo.
    expect(names()).toContain('arquivo4949.cpp');
    expect(rows().length).toBeLessThan(100);
    expect(p95).toBeLessThan(SCROLL_STEP_BUDGET_MS);
  });

  it('fechar e reabrir a pasta depois de rolar mostra a árvore a partir do topo', async () => {
    rows()[0].click();
    await render();
    Object.defineProperty(viewport, 'scrollTop', { value: 3000 * 22, configurable: true });
    viewport.dispatchEvent(new Event('scroll'));
    await render();

    const folder = TestBed.inject(CurrentFolder);
    folder.path.set(null);
    await render();
    folder.path.set(ROOT);
    await render();

    expect(names()[0]).toBe('muitos');
  });
});
