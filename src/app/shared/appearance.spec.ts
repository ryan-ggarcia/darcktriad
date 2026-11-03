import { TestBed } from '@angular/core/testing';
import { createFakes, Fakes, settle } from '../../testing/fakes';
import { Appearance, hasFluidAcrylic } from './appearance';

describe('Appearance', () => {
  let fakes: Fakes;
  const root = document.documentElement;

  beforeEach(() => {
    localStorage.clear();
    delete root.dataset['theme'];
    delete root.dataset['material'];
    fakes = createFakes();
    TestBed.configureTestingModule({ providers: fakes.providers });
  });

  afterEach(() => localStorage.clear());

  async function start(): Promise<Appearance> {
    const appearance = TestBed.inject(Appearance);
    appearance.start();
    TestBed.tick();
    await settle();
    return appearance;
  }

  it('aplica o tema e o material salvos: na página, no editor (sinais) e na janela', async () => {
    localStorage.setItem('theme', 'light');
    localStorage.setItem('material', 'glass');

    const appearance = await start();

    expect(root.dataset['theme']).toBe('light');
    expect(root.dataset['material']).toBe('glass');
    expect(appearance.glass()).toBe(true);
    // O efeito da janela liga antes de a página ficar transparente (docs/ipc.md, Janela).
    expect(fakes.window.calls).toEqual(['setTheme light', 'setGlass true (página: nenhum)']);
  });

  it('trocar grava a escolha; ao sair do vidro, a página fica opaca antes de desligar o efeito', async () => {
    localStorage.setItem('material', 'glass');
    const appearance = await start();
    fakes.window.calls.length = 0;

    appearance.toggleTheme();
    appearance.toggleMaterial();
    TestBed.tick();
    await settle();

    expect(localStorage.getItem('theme')).toBe('light');
    expect(localStorage.getItem('material')).toBe('solid');
    expect(root.dataset['material']).toBe('solid');
    expect(appearance.glass()).toBe(false);
    expect(fakes.window.calls).toEqual(['setTheme light', 'setGlass false (página: solid)']);
  });

  it('sem nada salvo: tema escuro; no Linux, sólido (sem desfoque, o vidro só atrapalha a leitura)', async () => {
    const appearance = await start();

    expect(root.dataset['theme']).toBe('dark');
    // Os testes rodam como Linux: o jsdom não diz "Windows" nem "Mac" no userAgent.
    expect(appearance.material()).toBe('solid');
    expect(root.dataset['material']).toBe('solid');
  });

  it('valor estranho no armazenamento vale o padrão', async () => {
    localStorage.setItem('theme', 'roxo');
    localStorage.setItem('material', '???');

    const appearance = await start();

    expect(appearance.theme()).toBe('dark');
    expect(appearance.material()).toBe('solid');
  });
});

describe('hasFluidAcrylic', () => {
  const version = (platformVersion: string): void => {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { getHighEntropyValues: () => Promise.resolve({ platformVersion }) },
    });
  };

  afterEach(() => Reflect.deleteProperty(navigator, 'userAgentData'));

  it('só a partir do Windows 11 22H2: antes disso o Acrylic deixa a janela lenta', async () => {
    version('10.0.0');
    expect(await hasFluidAcrylic()).toBe(false);
    version('13.0.0');
    expect(await hasFluidAcrylic()).toBe(false);
    version('14.0.0');
    expect(await hasFluidAcrylic()).toBe(true);
    version('19.0.0');
    expect(await hasFluidAcrylic()).toBe(true);
  });

  it('sem a informação do sistema, não oferece o vidro', async () => {
    expect(await hasFluidAcrylic()).toBe(false);
  });
});
