import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { Entry, ExplorerService } from './explorer.service';

describe('App', () => {
  async function openFolder(list: ExplorerService['list']): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      providers: [{ provide: ExplorerService, useValue: { list } }],
    });
    const fixture = TestBed.createComponent(App);
    const page = fixture.nativeElement as HTMLElement;
    page.querySelector('input')!.value = 'C:/projeto';
    page.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    return page;
  }

  it('lista o conteúdo da pasta, marcando pastas com barra', async () => {
    const entries: Entry[] = [
      { name: 'src', path: 'C:/projeto/src', isDir: true },
      { name: 'main.cpp', path: 'C:/projeto/main.cpp', isDir: false },
    ];

    const page = await openFolder(async () => entries);

    const items = [...page.querySelectorAll('li')].map((item) => item.textContent?.trim());
    expect(items).toEqual(['src/', 'main.cpp']);
  });

  it('mostra o erro quando a pasta não pode ser lida', async () => {
    const page = await openFolder(() => Promise.reject('pasta não encontrada'));

    expect(page.querySelector('[role=alert]')?.textContent).toContain('pasta não encontrada');
  });
});
