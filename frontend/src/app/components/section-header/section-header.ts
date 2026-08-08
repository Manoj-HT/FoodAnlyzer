import { Component, input } from '@angular/core';

@Component({
  selector: 'app-section-header',
  standalone: true,
  templateUrl: './section-header.html',
  styleUrl: './section-header.scss'
})
export class SectionHeaderComponent {
  emoji = input<string>('');
  title = input.required<string>();
  subtitle = input<string>('');
}
