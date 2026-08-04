import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { ServerStatusService } from '../../../services/server-status';

@Component({
  selector: 'app-server-cold-start-modal',
  standalone: true,
  templateUrl: './server-cold-start-modal.html',
  styleUrl: './server-cold-start-modal.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ServerColdStartModalComponent {
  readonly serverStatus = inject(ServerStatusService);
}
