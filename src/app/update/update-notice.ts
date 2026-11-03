import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { EditorTabs } from '../editor/editor-tabs';
import { PLATFORM } from '../shared/keybindings';
import { Updates, UpdateState } from './updates';

type Installing = Extract<UpdateState, { kind: 'installing' }>;

/** No .deb e no .rpm o `update_install` espera a senha: sem este texto, parece travado. */
const PASSWORD_HINT = PLATFORM === 'linux' ? ' O sistema pode pedir a sua senha.' : '';

function downloadDone({ downloaded, total }: Installing): boolean {
  return total !== null && downloaded >= total;
}

function title(state: UpdateState | null): string {
  switch (state?.kind) {
    case 'checking':
      return 'Verificando atualizações…';
    case 'upToDate':
      return 'O Dark Triad está atualizado.';
    case 'available':
      return `Dark Triad ${state.version} disponível`;
    case 'installing':
      return downloadDone(state)
        ? `Concluindo a atualização para o Dark Triad ${state.version}.${PASSWORD_HINT}`
        : `Baixando o Dark Triad ${state.version}`;
    case 'ready':
      return 'Atualização pronta';
    case 'restarting':
      return 'Reiniciando o Dark Triad…';
    case 'failed':
      return state.message;
    default:
      return '';
  }
}

/** Percentual para a barra; `null` a deixa em movimento, sem valor (sem total, ou já instalando). */
export function percent(state: Installing): number | null {
  return state.total && !downloadDone(state)
    ? Math.floor((state.downloaded * 100) / state.total)
    : null;
}

export function amount(state: Installing): string {
  if (downloadDone(state)) return '';
  if (state.total) return `${percent(state)}%`;
  if (!state.downloaded) return 'Iniciando…';
  const megabytes = (state.downloaded / 1024 / 1024).toLocaleString('pt-BR', {
    maximumFractionDigits: 1,
  });
  return `${megabytes} MB baixados.${PASSWORD_HINT}`;
}

/**
 * O aviso da atualização, abaixo do editor: nunca pega o foco. O `role=status` fica sempre na
 * página, porque leitores de tela só anunciam mudanças numa região que já existia. O progresso
 * fica fora dela, senão cada percentual seria lido em voz alta.
 */
@Component({
  selector: 'app-update-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.update-notice]': '!!updates.state()',
    '[class.banner]': '!!updates.state()',
    '[class.banner-info]': "!!updates.state() && updates.state()?.kind !== 'failed'",
  },
  template: `
    <p class="update-message" role="status" aria-atomic="true">{{ message() }}</p>
    @if (updates.state(); as state) {
      @if (state.kind === 'installing') {
        <progress
          class="update-progress"
          max="100"
          aria-label="Progresso da atualização"
          [attr.value]="percent(state)"
        ></progress>
        <span>{{ amount(state) }}</span>
      }
      <!-- O botão clicado some com o estado: o foco volta para o editor, em vez de se perder. -->
      <div class="update-actions" (click)="tabs.requestFocus()">
        @switch (state.kind) {
          @case ('available') {
            <button
              type="button"
              class="primary"
              title="Atualizar: baixa e instala a versão nova. Dá para continuar trabalhando."
              (click)="updates.install()"
            >
              Atualizar
            </button>
            <button
              type="button"
              title="Depois: esconde este aviso até a próxima abertura"
              (click)="updates.hide()"
            >
              Depois
            </button>
          }
          @case ('ready') {
            <button
              type="button"
              class="primary"
              title="Reiniciar agora: pergunta antes sobre o que não foi salvo ou está rodando"
              (click)="updates.restart()"
            >
              Reiniciar agora
            </button>
            <button
              type="button"
              title="Depois: continua nesta versão; o aviso volta pelo comando Ajuda: Verificar atualizações"
              (click)="updates.hide()"
            >
              Depois
            </button>
          }
          @case ('failed') {
            <button
              type="button"
              class="primary"
              title="Tentar de novo: verifica outra vez e refaz o que falhou"
              (click)="updates.retry()"
            >
              Tentar de novo
            </button>
            <button type="button" title="Fechar este aviso" (click)="updates.hide()">Fechar</button>
          }
          @case ('upToDate') {
            <button type="button" title="Fechar este aviso" (click)="updates.hide()">Fechar</button>
          }
        }
      </div>
      <!-- Texto vindo da internet: só como texto (textContent), nunca como HTML ou Markdown. -->
      @if (state.kind === 'available' && state.notes?.trim()) {
        <details class="update-notes">
          <summary title="Ver novidades desta versão">Ver novidades</summary>
          <div
            class="update-notes-text"
            tabindex="0"
            role="region"
            aria-label="Novidades"
            [textContent]="state.notes"
          ></div>
        </details>
      }
    }
  `,
})
export class UpdateNotice {
  protected readonly updates = inject(Updates);
  protected readonly tabs = inject(EditorTabs);
  protected readonly message = computed(() => title(this.updates.state()));
  protected readonly percent = percent;
  protected readonly amount = amount;
}
