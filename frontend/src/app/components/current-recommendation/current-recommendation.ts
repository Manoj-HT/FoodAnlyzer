import { Component, OnInit, OnDestroy, ElementRef, ViewChild, inject, signal, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Chart from 'chart.js/auto';
import { AuthService } from '../../services/auth';
import { IndexedDbService } from '../../services/indexed-db';
import { LogsStateService } from '../../services/logs-state';

interface RecommendationCard {
  title: string;
  emoji: string;
  description: string;
  tips: string[];
}

import { SectionHeaderComponent } from '../section-header/section-header';

@Component({
  selector: 'app-current-recommendation',
  standalone: true,
  imports: [CommonModule, FormsModule, SectionHeaderComponent],
  templateUrl: './current-recommendation.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './current-recommendation.scss',
})
export class CurrentRecommendationComponent implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly dbService = inject(IndexedDbService);
  private readonly logsState = inject(LogsStateService);
  private readonly cdr = inject(ChangeDetectorRef);

  isLoading = signal(true);
  isGenerating = signal(false);
  streamText = signal('');
  userName = signal('Member');
  rawBio = signal('');
  wellnessGoals = signal<string[]>([]);
  recommendations = signal<RecommendationCard[]>([]);

  monthlyData = signal<any>(null);
  weeklyReports = signal<any[]>([]);

  // Analytics Graph States
  selectedMetric = signal<'all' | 'calories_burned' | 'protein' | 'fibre' | 'carbs' | 'vitamins'>('all');
  selectedTimeframe = signal<'daily' | 'weekly' | 'monthly'>('daily');
  graphData = signal<any>(null);
  isGraphLoading = signal(true);

  @ViewChild('analyticsCanvas', { static: false }) analyticsCanvasRef?: ElementRef<HTMLCanvasElement>;
  private chartInstance: Chart | null = null;

  ngOnInit(): void {
    const userid = this.authService.getUserId();
    const localUser = this.authService.getLocalUser();

    if (localUser) {
      this.userName.set(localUser.name || 'Member');
      this.rawBio.set(localUser.userdetails || '');
      this.generateRecommendations(localUser.userdetails || '', []);
    }

    if (userid) {
      // 1. Fetch monthly aggregation and insights via stateless stream
      this.fetchRecommendationsStream(userid);

      // 2. Fetch analytics graph data
      this.fetchGraphData(userid);
    } else {
      this.isLoading.set(false);
      this.cdr.markForCheck();
    }
  }

  async fetchRecommendationsStream(userid: string, regenerate: boolean = false): Promise<void> {
    // Check if valid monthly cached recommendation stream exists
    if (!regenerate) {
      const cached = this.logsState.getCachedStream();
      if (cached) {
        this.monthlyData.set(cached.monthlyData);
        this.weeklyReports.set(cached.weeklyReports || []);
        this.streamText.set(cached.streamText || '');
        this.isGenerating.set(false);
        this.isLoading.set(false);
        this.cdr.markForCheck();
        setTimeout(() => this.renderChart(), 100);
        return;
      }
    }

    try {
      const [meals, activities, profile, monthlyAggs] = await Promise.all([
        this.dbService.getMealLogs(userid),
        this.dbService.getActivityLogs(userid),
        this.dbService.getUserProfile(userid),
        this.dbService.getMonthlyAggregates(userid)
      ]);

      const deviceHealthDetails = this.authService.getUserHealthDetails(userid);
      const userDetails = profile?.structured_details ? JSON.stringify(profile.structured_details) : (deviceHealthDetails || this.rawBio());
      this.generateRecommendations(userDetails, []);

      const payload = {
        user_id: userid,
        user_name: profile?.name || this.userName(),
        user_details: userDetails,
        meal_logs: meals,
        activity_logs: activities,
        monthly_aggregates: monthlyAggs,
        regenerate
      };

      const url = this.authService.getStatelessRecommendationsStreamUrl();
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

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
        buffer = lines.pop() || '';

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
      console.warn('Stateless streaming failed, using GET stream fallback:', err);
      try {
        const url = this.authService.getRecommendationsStreamUrl(userid, regenerate);
        const response = await fetch(url);
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                this.handleStreamMessage(JSON.parse(trimmed));
              } catch (e) {}
            }
          }
        }
      } catch (fallbackErr) {
        console.error('Fallback load failed:', fallbackErr);
        this.isLoading.set(false);
        this.cdr.markForCheck();
      }
    }
  }

  activeEngine = signal<string>('SYSTEM');

  handleStreamMessage(data: any): void {
    if (data.engine) {
      const displayEngine = data.engine === 'fallback' ? 'SYSTEM' : data.engine;
      this.activeEngine.set(displayEngine);
    }

    if (data.type === 'meta') {
      this.weeklyReports.set(data.weekly_reports || []);
      this.monthlyData.set(data.monthly_data);

      if (data.engine) {
        const displayEngine = data.engine === 'fallback' ? 'SYSTEM' : data.engine;
        this.activeEngine.set(displayEngine);
      } else if (data.monthly_data?.engine) {
        const displayEngine = data.monthly_data.engine === 'fallback' ? 'SYSTEM' : data.monthly_data.engine;
        this.activeEngine.set(displayEngine);
      }

      if (data.cached) {
        this.isGenerating.set(false);
        this.isLoading.set(false);
      } else {
        this.isGenerating.set(true);
        this.streamText.set('');
        this.isLoading.set(false);
      }
      this.cdr.markForCheck();
      setTimeout(() => this.renderChart(), 100);
    } else if (data.type === 'status') {
      if (data.engine) {
        const displayEngine = data.engine === 'fallback' ? 'SYSTEM' : data.engine;
        this.activeEngine.set(displayEngine);
      }
      this.cdr.markForCheck();
    } else if (data.type === 'token') {
      this.streamText.set(this.streamText() + data.token);
      this.cdr.markForCheck();
    } else if (data.type === 'done') {
      this.isGenerating.set(false);
      if (data.engine) {
        const displayEngine = data.engine === 'fallback' ? 'SYSTEM' : data.engine;
        this.activeEngine.set(displayEngine);
      }

      // Update monthlyData with the finalized insights list
      const current = this.monthlyData();
      if (current) {
        this.monthlyData.set({
          ...current,
          insights: data.insights,
          insight_version: data.insight_version,
          last_insight_generated_time: data.last_insight_generated_time,
          engine: this.activeEngine()
        });
      }

      // Cache the complete recommendations stream with monthly timestamp
      this.logsState.setCachedStream(
        this.streamText(),
        this.monthlyData(),
        this.weeklyReports()
      );
      this.cdr.markForCheck();
      setTimeout(() => this.renderChart(), 100);
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

    // Fallback cards if empty
    if (cards.length === 0) {
      goals.push('General Health & Micronutrient Density');
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
      cards.push({
        title: 'Hydration & Daily Movement',
        emoji: '💧',
        description:
          'Adequate daily hydration and light movement are foundational for metabolic health.',
        tips: [
          'Drink a glass of water first thing upon waking up in the morning.',
          'Aim for at least 30 minutes of light or moderate physical activity daily.',
          'Take short movement breaks every hour during sedentary desk work.',
        ],
      });
      cards.push({
        title: 'Sleep & Recovery Balance',
        emoji: '🌙',
        description:
          'Restorative sleep regulates appetite hormones (ghrelin and leptin) and lowers cortisol levels.',
        tips: [
          'Maintain a consistent sleep routine aiming for 7-9 hours per night.',
          'Limit caffeine and heavy meals 4 hours before bedtime.',
        ],
      });
    }

    this.wellnessGoals.set(goals);
    this.recommendations.set(cards);
    this.cdr.markForCheck();
  }

  regenerateInsights(): void {
    const userid = this.authService.getUserId();
    if (!userid) return;

    this.isGenerating.set(true);
    this.streamText.set('');
    
    // Call the stream generation with force regenerate option
    this.fetchRecommendationsStream(userid, true);
  }

  fetchGraphData(userid: string): void {
    this.isGraphLoading.set(true);
    this.logsState.getGraphData(this.authService, userid).subscribe({
      next: (data) => {
        this.graphData.set(data);
        this.isGraphLoading.set(false);
        this.cdr.markForCheck();
        setTimeout(() => this.renderChart(), 100);
      },
      error: (err) => {
        console.error('Failed to load analytics graph data:', err);
        this.isGraphLoading.set(false);
        this.cdr.markForCheck();
      }
    });
  }

  renderChart(): void {
    const canvas = this.analyticsCanvasRef?.nativeElement;
    if (!canvas) {
      setTimeout(() => this.renderChart(), 100);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }

    const timeframe = this.selectedTimeframe();
    const metric = this.selectedMetric();
    const data = this.graphData();
    const currentSet = (data && data[timeframe]) ? data[timeframe] : {};

    let labels: string[] = [];
    let defaultLen = 30;

    if (timeframe === 'daily') {
      const now = new Date();
      const monthAbbr = now.toLocaleString('en-US', { month: 'short' });
      defaultLen = currentSet.calories_burned?.length || 30;
      labels = Array.from({ length: defaultLen }, (_, i) => `${monthAbbr} ${i + 1}`);
    } else if (timeframe === 'weekly') {
      defaultLen = 4;
      labels = ['Week 1 (Days 1-7)', 'Week 2 (Days 8-14)', 'Week 3 (Days 15-21)', 'Week 4 (Days 22+)'];
    } else if (timeframe === 'monthly') {
      defaultLen = 12;
      labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    }

    const safeCal = currentSet.calories_burned && currentSet.calories_burned.length ? currentSet.calories_burned : new Array(defaultLen).fill(0);
    const safeProtein = currentSet.protein && currentSet.protein.length ? currentSet.protein : new Array(defaultLen).fill(0);
    const safeFibre = currentSet.fibre && currentSet.fibre.length ? currentSet.fibre : new Array(defaultLen).fill(0);
    const safeCarbs = currentSet.carbs && currentSet.carbs.length ? currentSet.carbs : new Array(defaultLen).fill(0);
    const safeVitamins = currentSet.vitamins && currentSet.vitamins.length ? currentSet.vitamins : new Array(defaultLen).fill(0);

    const safeSet: Record<string, number[]> = {
      calories_burned: safeCal,
      protein: safeProtein,
      fibre: safeFibre,
      carbs: safeCarbs,
      vitamins: safeVitamins
    };

    const metricConfigs: Record<string, { label: string; color: string; bgGradient: string }> = {
      calories_burned: {
        label: 'Calories Burned (kcal)',
        color: '#1d4ed8',
        bgGradient: 'rgba(29, 78, 216, 0.15)'
      },
      protein: {
        label: 'Protein Intake (g)',
        color: '#10b981',
        bgGradient: 'rgba(16, 185, 129, 0.15)'
      },
      fibre: {
        label: 'Fibre Intake (g)',
        color: '#059669',
        bgGradient: 'rgba(5, 150, 105, 0.15)'
      },
      carbs: {
        label: 'Carb Intake (g)',
        color: '#f59e0b',
        bgGradient: 'rgba(245, 158, 11, 0.15)'
      },
      vitamins: {
        label: 'Vitamin Intake Score (0-100)',
        color: '#8b5cf6',
        bgGradient: 'rgba(139, 92, 246, 0.15)'
      }
    };

    let datasets: any[] = [];
    let scalesConfig: any = {};

    if (metric === 'all') {
      datasets = [
        {
          label: '🔥 Calories Burned (kcal)',
          data: safeSet['calories_burned'],
          borderColor: '#1d4ed8',
          backgroundColor: 'rgba(29, 78, 216, 0.08)',
          yAxisID: 'y',
          fill: false,
          tension: 0.4,
          borderWidth: 3,
          pointRadius: 4,
          pointHoverRadius: 7
        },
        {
          label: '🥩 Protein (g)',
          data: safeSet['protein'],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.08)',
          yAxisID: 'y1',
          fill: false,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 4,
          pointHoverRadius: 7
        },
        {
          label: '🌾 Fibre (g)',
          data: safeSet['fibre'],
          borderColor: '#059669',
          backgroundColor: 'rgba(5, 150, 105, 0.08)',
          yAxisID: 'y1',
          fill: false,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 4,
          pointHoverRadius: 7
        },
        {
          label: '🍞 Carbs (g)',
          data: safeSet['carbs'],
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.08)',
          yAxisID: 'y1',
          fill: false,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 4,
          pointHoverRadius: 7
        },
        {
          label: '⚡ Vitamin Score',
          data: safeSet['vitamins'],
          borderColor: '#8b5cf6',
          backgroundColor: 'rgba(139, 92, 246, 0.08)',
          yAxisID: 'y1',
          fill: false,
          tension: 0.4,
          borderWidth: 2.5,
          pointRadius: 4,
          pointHoverRadius: 7
        }
      ];

      scalesConfig = {
        x: {
          grid: { color: 'rgba(0, 0, 0, 0.05)' },
          ticks: { color: '#4b5563', font: { family: 'Inter', size: 11 } }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          title: { display: true, text: 'Calories (kcal)', color: '#1d4ed8', font: { family: 'Inter', size: 11, weight: 'bold' } },
          beginAtZero: true,
          grid: { color: 'rgba(0, 0, 0, 0.05)' },
          ticks: { color: '#1d4ed8', font: { family: 'Inter', size: 11 } }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          title: { display: true, text: 'Macros (g) / Vitamin Score', color: '#10b981', font: { family: 'Inter', size: 11, weight: 'bold' } },
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          ticks: { color: '#10b981', font: { family: 'Inter', size: 11 } }
        }
      };
    } else {
      const values = safeSet[metric] || safeSet['calories_burned'];
      const cfg = metricConfigs[metric] || metricConfigs['calories_burned'];

      datasets = [{
        label: cfg.label,
        data: values,
        borderColor: cfg.color,
        backgroundColor: cfg.bgGradient,
        fill: true,
        tension: 0.4,
        borderWidth: 3,
        pointRadius: 4,
        pointHoverRadius: 7,
        pointBackgroundColor: cfg.color,
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2
      }];

      scalesConfig = {
        x: {
          grid: { color: 'rgba(0, 0, 0, 0.05)' },
          ticks: { color: '#4b5563', font: { family: 'Inter', size: 11 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0, 0, 0, 0.05)' },
          ticks: { color: '#4b5563', font: { family: 'Inter', size: 11 } }
        }
      };
    }

    this.chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              font: {
                family: 'Inter',
                size: 12,
                weight: 'bold'
              },
              color: '#1f2937'
            }
          },
          tooltip: {
            backgroundColor: 'rgba(17, 24, 39, 0.9)',
            titleFont: { family: 'Outfit', size: 14 },
            bodyFont: { family: 'Inter', size: 13 },
            padding: 12,
            cornerRadius: 10
          }
        },
        scales: scalesConfig
      }
    });
  }

  onMetricChange(metric: any): void {
    this.selectedMetric.set(metric);
    this.renderChart();
  }

  onTimeframeChange(timeframe: 'daily' | 'weekly' | 'monthly'): void {
    this.selectedTimeframe.set(timeframe);
    this.renderChart();
  }

  ngOnDestroy(): void {
    if (this.chartInstance) {
      this.chartInstance.destroy();
    }
  }
}

