import { Component, inject, signal } from '@angular/core';
import { Entry, ExplorerService } from './explorer.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  private readonly explorer = inject(ExplorerService);
  protected readonly entries = signal<Entry[]>([]);
  protected readonly error = signal('');

  protected async open(path: string): Promise<void> {
    this.entries.set([]);
    this.error.set('');
    try {
      this.entries.set(await this.explorer.list(path));
    } catch (error) {
      this.error.set(String(error));
    }
  }
}
