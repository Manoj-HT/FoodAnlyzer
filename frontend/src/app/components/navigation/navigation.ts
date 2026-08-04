import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './navigation.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './navigation.scss',
})
export class NavigationComponent {}
