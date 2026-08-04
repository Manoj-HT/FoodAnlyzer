import { Component, signal, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { WebMcpService } from './services/webmcp';
import { ServerColdStartModalComponent } from './utilities/components/server-cold-start-modal/server-cold-start-modal';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ServerColdStartModalComponent],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = signal('frontend-app');
  private readonly webMcpService = inject(WebMcpService);
}
