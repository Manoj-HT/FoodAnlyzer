import { Injectable, signal } from '@angular/core';

export type AccordionTab = 'meal' | 'activity';

@Injectable({
  providedIn: 'root'
})
export class AccordionStateService {
  activeTab = signal<AccordionTab>('meal');

  setActiveTab(tab: AccordionTab): void {
    this.activeTab.set(tab);
  }

  toggleTab(tab: AccordionTab): void {
    if (this.activeTab() === tab) {
      // Keep selected or toggle
      return;
    }
    this.activeTab.set(tab);
  }
}
