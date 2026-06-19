import { Component, model, input, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-modal',
  standalone: true,
  templateUrl: './modal.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './modal.scss',
})
export class ModalComponent {
  isOpen = model<boolean>(false);
  title = input<string>('');

  close(): void {
    this.isOpen.set(false);
  }
}
