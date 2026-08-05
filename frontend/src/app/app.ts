import { Component, signal, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { WebMcpService } from './services/webmcp';
import { AuthService } from './services/auth';
import { NavigationComponent } from './components/navigation/navigation';
import { ServerColdStartModalComponent } from './utilities/components/server-cold-start-modal/server-cold-start-modal';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, NavigationComponent, ServerColdStartModalComponent],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = signal('frontend-app');
  private readonly webMcpService = inject(WebMcpService);
  protected readonly authService = inject(AuthService);
}
