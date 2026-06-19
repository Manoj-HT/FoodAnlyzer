import { Component, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../../services/auth';
import { NavigationComponent } from '../navigation/navigation';

interface RecommendationCard {
  title: string;
  emoji: string;
  description: string;
  tips: string[];
}

@Component({
  selector: 'app-current-recommendation',
  standalone: true,
  imports: [CommonModule, NavigationComponent],
  templateUrl: './current-recommendation.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './current-recommendation.scss',
})
export class CurrentRecommendationComponent implements OnInit {
  private readonly authService = inject(AuthService);

  isLoading = signal(true);
  isGenerating = signal(false);
  streamText = signal('');
  userName = signal('Member');
  rawBio = signal('');
  wellnessGoals = signal<string[]>([]);
  recommendations = signal<RecommendationCard[]>([]);

  monthlyData = signal<any>(null);
  weeklyReports = signal<any[]>([]);

  ngOnInit(): void {
    const userid = this.authService.getUserId();
    if (userid) {
      // 1. Fetch user details first
      this.authService.getUserDetails(userid).subscribe({
        next: (user) => {
          this.userName.set(user.name || 'Member');
          this.rawBio.set(user.userdetails || '');
          this.generateRecommendations(user.userdetails || '', []);

          // 2. Fetch monthly aggregation and insights via stream
          this.fetchRecommendationsStream(userid);
        },
        error: (err) => {
          console.error('Failed to load user details for recommendations:', err);
          this.isLoading.set(false);
        },
      });
    } else {
      this.isLoading.set(false);
    }
  }

  async fetchRecommendationsStream(userid: string): Promise<void> {
    try {
      const url = this.authService.getRecommendationsStreamUrl(userid);
      const response = await fetch(url);

      if (!response.body) {
        throw new Error('Readable stream not supported by browser response.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Hold partial line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const data = JSON.parse(trimmed);
            this.handleStreamMessage(data);
          } catch (e) {
            console.error('Failed to parse line from stream:', trimmed, e);
          }
        }
      }
    } catch (err) {
      console.warn('Streaming failed or timed out. Falling back to static HTTP load:', err);
      // Fallback: Fetch via normal JSON API
      this.authService.getRecommendations(userid).subscribe({
        next: (data) => {
          this.monthlyData.set(data.monthly_data);
          this.weeklyReports.set(data.weekly_reports || []);
          this.isGenerating.set(false);
          this.isLoading.set(false);
        },
        error: (fallbackErr) => {
          console.error('Fallback static load failed too:', fallbackErr);
          this.isLoading.set(false);
        },
      });
    }
  }

  handleStreamMessage(data: any): void {
    if (data.type === 'meta') {
      this.weeklyReports.set(data.weekly_reports || []);
      this.monthlyData.set(data.monthly_data);

      if (data.cached) {
        this.isGenerating.set(false);
        this.isLoading.set(false);
      } else {
        this.isGenerating.set(true);
        this.streamText.set('');
        this.isLoading.set(false);
      }
    } else if (data.type === 'token') {
      this.streamText.set(this.streamText() + data.token);
    } else if (data.type === 'done') {
      this.isGenerating.set(false);
      // Update monthlyData with the finalized insights list
      const current = this.monthlyData();
      if (current) {
        this.monthlyData.set({
          ...current,
          insights: data.insights,
          insight_version: data.insight_version,
          last_insight_generated_time: data.last_insight_generated_time,
        });
      }
    } else if (data.type === 'error') {
      console.error('Error emitted in backend stream:', data.detail);
    }
  }

  formatDate(isoString: string): string {
    if (!isoString) return 'N/A';
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return isoString;
    }
  }

  getGradeColorClass(grade: string): string {
    if (!grade) return 'grade-neutral';
    const g = grade.toUpperCase();
    if (g.startsWith('A')) return 'grade-a';
    if (g.startsWith('B')) return 'grade-b';
    if (g.startsWith('C')) return 'grade-c';
    return 'grade-d';
  }

  getConfidenceColorClass(score: number): string {
    if (score >= 75) return 'conf-high';
    if (score >= 40) return 'conf-mid';
    return 'conf-low';
  }

  private generateRecommendations(bio: string, modifications: string[]): void {
    const text = (bio + ' ' + modifications.join(' ')).toLowerCase();
    const cards: RecommendationCard[] = [];
    const goals: string[] = [];

    // 1. Protein intake
    if (
      text.includes('protein') ||
      text.includes('muscle') ||
      text.includes('gain') ||
      text.includes('hypertrophy')
    ) {
      goals.push('High-Protein & Hypertrophy Focus');
      cards.push({
        title: 'Lean Protein Optimization',
        emoji: '🥩',
        description:
          'To support muscle building and tissue recovery, target 1.6g to 2.2g of protein per kilogram of bodyweight.',
        tips: [
          'Prioritize high-quality sources like chicken breast, fish, egg whites, Greek yogurt, or soy proteins.',
          'Distribute protein intake evenly across 3 to 5 meals per day (approx. 25-40g per meal) to maximize protein synthesis.',
          'Consider a fast-digesting protein source (like whey or pea protein) within 1-2 hours post-workout.',
        ],
      });
    }

    // 2. Calorie deficit / weight management
    if (text.includes('weight') || text.includes('lose') || text.includes('deficit')) {
      goals.push('Weight Management & Deficit support');
      cards.push({
        title: 'Calorie Deficit Strategy',
        emoji: '📉',
        description:
          'For sustainable fat loss, target a moderate deficit of 300 to 500 calories below your daily TDEE.',
        tips: [
          'Focus on low-calorie density, high-volume foods (like leafy greens, berries, cucumbers) to keep yourself full.',
          'Start meals with a glass of water and a fiber-rich salad to naturally control portion sizes.',
          'Track sauces, cooking oils, and liquid calories which can secretly erase a deficit.',
        ],
      });
    }

    // 3. Active routine / cardio
    if (
      text.includes('run') ||
      text.includes('cardio') ||
      text.includes('walk') ||
      text.includes('active')
    ) {
      goals.push('Endurance & Aerobic Conditioning');
      cards.push({
        title: 'Cardiovascular Fueling',
        emoji: '🏃',
        description:
          'A physically active routine requires adequate complex carbohydrates and electrolyte management to maintain glycogen levels.',
        tips: [
          'Eat a small snack of easily-digestible carbs (e.g. banana or oats) 60-90 minutes before prolonged training.',
          'Drink at least 500ml of water per hour of workout. Supplement with electrolytes if sweating for over 60 mins.',
          'Ensure sufficient intake of anti-inflammatory fats (omega-3s) to support joint recovery.',
        ],
      });
    }

    // 4. Diabetes / Glycemic management
    if (
      text.includes('diabet') ||
      text.includes('insulin') ||
      text.includes('glycemic') ||
      text.includes('sugar')
    ) {
      goals.push('Blood Glucose & Glycemic Care');
      cards.push({
        title: 'Insulin Sensitivity & Complex Carbs',
        emoji: '🥗',
        description:
          'Focus on low-glycemic load foods to prevent sharp blood sugar spikes and promote long-lasting satiety.',
        tips: [
          'Pair any carbohydrate source with a protein or healthy fat to slow down sugar absorption.',
          'Opt for whole grains (quinoa, brown rice, steel-cut oats) rather than refined white flour products.',
          'Add high-fiber legumes (lentils, black beans) which act as natural glucose regulators.',
        ],
      });
    }

    // 5. High blood pressure / Low sodium
    if (
      text.includes('pressure') ||
      text.includes('hypertension') ||
      text.includes('sodium') ||
      text.includes('salt')
    ) {
      goals.push('Cardiovascular Support (Low Sodium)');
      cards.push({
        title: 'Sodium Reduction & Cardiovascular Care',
        emoji: '❤️',
        description:
          'Support healthy blood pressure levels by restricting daily sodium intake to under 1500-2000mg.',
        tips: [
          'Read nutrition labels carefully: look for "low sodium" or "no added salt" alternatives.',
          'Flavor meals using fresh herbs, garlic, onion, lemon juice, or spices instead of table salt.',
          'Increase potassium-rich food intake (bananas, sweet potatoes, spinach) to help balance sodium levels.',
        ],
      });
    }

    // 6. Allergies / Restrictions
    if (text.includes('gluten') || text.includes('celiac')) {
      goals.push('Gluten Sensitivity Precautions');
      cards.push({
        title: 'Gluten-Free Guidance',
        emoji: '🌾',
        description:
          'Avoid gluten-containing grains (wheat, barley, rye) and monitor for cross-contamination.',
        tips: [
          'Choose naturally gluten-free carbohydrates like sweet potatoes, squash, wild rice, and quinoa.',
          'Ensure gluten-free labeling on oats, baking mixes, and sauces.',
          'Maintain a food diary to note if digestive discomfort matches hidden gluten sources.',
        ],
      });
    }

    if (text.includes('lactose') || text.includes('dairy') || text.includes('milk')) {
      goals.push('Lactose Sensitivity Precautions');
      cards.push({
        title: 'Dairy-Free & Lactose Sensitivity',
        emoji: '🥛',
        description:
          'Avoid standard cow dairy products to alleviate lactose intolerance digestive symptoms.',
        tips: [
          'Use fortified plant-based milk (almond, soy, oat) rich in calcium and vitamin D.',
          'Consider Greek yogurt or hard cheeses (parmesan) which naturally contain very little lactose, if tolerated.',
          'Look for calcium-rich green vegetables like broccoli, kale, and bok choy.',
        ],
      });
    }

    // Fallback card if empty
    if (cards.length === 0) {
      goals.push('General Nutrition Improvement');
      cards.push({
        title: 'Foundational Healthy Eating',
        emoji: '🥦',
        description:
          'Build a balanced wellness foundation focusing on whole foods and micronutrient density.',
        tips: [
          'Aim to fill half your plate with colorful vegetables and fruits to secure essential vitamins and minerals.',
          'Drink 2-3 liters of fresh water daily to stay hydrated and support cognitive focus.',
          'Minimize highly processed foods, excess refined sugars, and trans-fats.',
        ],
      });
    }

    this.wellnessGoals.set(goals);
    this.recommendations.set(cards);
  }
}
