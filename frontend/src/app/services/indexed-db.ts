import { Injectable } from '@angular/core';

export interface LocalMealLog {
  id?: number;
  userId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  time_period: 'Breakfast' | 'Lunch' | 'Dinner' | 'Snacks';
  description: string;
  food_item: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  grade?: string;
  tips?: string;
  timestamp: number;
}

export interface LocalActivityLog {
  id?: number;
  userId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  activity_name: string;
  duration_minutes: number;
  calories_burned: number;
  intensity?: string;
  timestamp: number;
}

export interface LocalUserProfile {
  userId: string;
  name: string;
  email: string;
  age?: number;
  height?: string;
  weight?: string;
  health_history?: string[];
  goals?: string[];
  structured_details?: any;
  updatedAt: number;
}

export interface LocalRecommendation {
  userId: string;
  markdownText: string;
  generatedAt: number;
  weekOffset: number;
}

export interface LocalMonthlyAggregate {
  userId: string;
  yearMonth: string; // "YYYY-MM"
  startDate: string;
  endDate: string;
  totalMealsLogged: number;
  avgDailyCalories: number;
  avgDailyProtein: number;
  avgDailyCarbs: number;
  avgDailyFat: number;
  totalWorkoutsLogged: number;
  totalCaloriesBurned: number;
  topFoods: string[];
  topActivities: string[];
  aggregatedAt: number;
}

export interface LocalNegativePrediction {
  userId: string;
  foodName: string;
  rejectedAt: number;
}

const DB_NAME = 'FoodAnlyzerLocalDB';
const DB_VERSION = 3;

@Injectable({
  providedIn: 'root',
})
export class IndexedDbService {
  private dbPromise: Promise<IDBDatabase>;
  private readonly PRUNE_THRESHOLD_MS = 270 * 24 * 60 * 60 * 1000; // 270 Days (~9 Months)

  constructor() {
    this.dbPromise = this.initDatabase();
    this.runAutomatedPruning();
  }

  private initDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Meal Logs store
        if (!db.objectStoreNames.contains('meal_logs')) {
          const mealStore = db.createObjectStore('meal_logs', { keyPath: 'id', autoIncrement: true });
          mealStore.createIndex('userId', 'userId', { unique: false });
          mealStore.createIndex('date', 'date', { unique: false });
          mealStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Activity Logs store
        if (!db.objectStoreNames.contains('activity_logs')) {
          const actStore = db.createObjectStore('activity_logs', { keyPath: 'id', autoIncrement: true });
          actStore.createIndex('userId', 'userId', { unique: false });
          actStore.createIndex('date', 'date', { unique: false });
          actStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // User Profile store
        if (!db.objectStoreNames.contains('user_profile')) {
          db.createObjectStore('user_profile', { keyPath: 'userId' });
        }

        // Recommendations store
        if (!db.objectStoreNames.contains('recommendations')) {
          const recStore = db.createObjectStore('recommendations', { keyPath: ['userId', 'weekOffset'] });
          recStore.createIndex('userId', 'userId', { unique: false });
        }

        // Monthly Aggregates store (Zero Data Loss Rolling Aggregation)
        if (!db.objectStoreNames.contains('monthly_aggregates')) {
          const aggStore = db.createObjectStore('monthly_aggregates', { keyPath: ['userId', 'yearMonth'] });
          aggStore.createIndex('userId', 'userId', { unique: false });
        }

        // Negative Predictions store (local rejection list for inferred meals)
        if (!db.objectStoreNames.contains('negative_predictions')) {
          const negStore = db.createObjectStore('negative_predictions', { keyPath: ['userId', 'foodName'] });
          negStore.createIndex('userId', 'userId', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        resolve((event.target as IDBOpenDBRequest).result);
      };

      request.onerror = (event) => {
        console.error('IndexedDB init error:', (event.target as IDBOpenDBRequest).error);
        reject((event.target as IDBOpenDBRequest).error);
      };
    });
  }

  /**
   * 9-Month Rolling Aggregation & Lifecycle:
   * Collects detailed logs older than 270 days (~9 months), aggregates them into compact
   * Monthly Summaries ('monthly_aggregates'), and then cleans up the raw daily items.
   */
  async runAutomatedPruning(): Promise<number> {
    const db = await this.dbPromise;
    const cutoffTimestamp = Date.now() - this.PRUNE_THRESHOLD_MS;
    let prunedCount = 0;

    const staleMeals: LocalMealLog[] = [];
    const staleActs: LocalActivityLog[] = [];

    // Step 1: Collect stale entries older than 270 days
    await new Promise<void>((resolve) => {
      const tx = db.transaction(['meal_logs', 'activity_logs'], 'readonly');
      
      const mealReq = tx.objectStore('meal_logs').index('timestamp').openCursor(IDBKeyRange.upperBound(cutoffTimestamp));
      mealReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          staleMeals.push(cursor.value);
          cursor.continue();
        }
      };

      const actReq = tx.objectStore('activity_logs').index('timestamp').openCursor(IDBKeyRange.upperBound(cutoffTimestamp));
      actReq.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          staleActs.push(cursor.value);
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
    });

    if (staleMeals.length === 0 && staleActs.length === 0) {
      return 0;
    }

    // Step 2: Group by YYYY-MM and userId
    const monthlyGroups: Record<string, { meals: LocalMealLog[]; acts: LocalActivityLog[] }> = {};

    for (const meal of staleMeals) {
      const ym = meal.date ? meal.date.substring(0, 7) : new Date(meal.timestamp).toISOString().substring(0, 7);
      const key = `${meal.userId}__${ym}`;
      if (!monthlyGroups[key]) monthlyGroups[key] = { meals: [], acts: [] };
      monthlyGroups[key].meals.push(meal);
    }

    for (const act of staleActs) {
      const ym = act.date ? act.date.substring(0, 7) : new Date(act.timestamp).toISOString().substring(0, 7);
      const key = `${act.userId}__${ym}`;
      if (!monthlyGroups[key]) monthlyGroups[key] = { meals: [], acts: [] };
      monthlyGroups[key].acts.push(act);
    }

    // Step 3: Compute monthly aggregates & delete raw stale records in a write transaction
    return new Promise((resolve) => {
      const tx = db.transaction(['meal_logs', 'activity_logs', 'monthly_aggregates'], 'readwrite');
      const aggStore = tx.objectStore('monthly_aggregates');

      for (const [key, group] of Object.entries(monthlyGroups)) {
        const [userId, yearMonth] = key.split('__');
        const totalMeals = group.meals.length;
        const totalActs = group.acts.length;

        const totalCals = group.meals.reduce((sum, m) => sum + (m.calories || 0), 0);
        const totalProt = group.meals.reduce((sum, m) => sum + (m.protein || 0), 0);
        const totalCarb = group.meals.reduce((sum, m) => sum + (m.carbs || 0), 0);
        const totalFat = group.meals.reduce((sum, m) => sum + (m.fat || 0), 0);
        const totalBurned = group.acts.reduce((sum, a) => sum + (a.calories_burned || 0), 0);

        // Top foods frequency
        const foodCounts: Record<string, number> = {};
        group.meals.forEach(m => {
          const item = m.food_item || m.description;
          if (item) foodCounts[item] = (foodCounts[item] || 0) + 1;
        });
        const topFoods = Object.entries(foodCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(e => e[0]);

        // Top activities frequency
        const actCounts: Record<string, number> = {};
        group.acts.forEach(a => {
          if (a.activity_name) actCounts[a.activity_name] = (actCounts[a.activity_name] || 0) + 1;
        });
        const topActivities = Object.entries(actCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(e => e[0]);

        const daysInMonth = 30; // Approximation for daily averages
        const aggRecord: LocalMonthlyAggregate = {
          userId,
          yearMonth,
          startDate: `${yearMonth}-01`,
          endDate: `${yearMonth}-${daysInMonth}`,
          totalMealsLogged: totalMeals,
          avgDailyCalories: Math.round(totalCals / daysInMonth),
          avgDailyProtein: Math.round(totalProt / daysInMonth),
          avgDailyCarbs: Math.round(totalCarb / daysInMonth),
          avgDailyFat: Math.round(totalFat / daysInMonth),
          totalWorkoutsLogged: totalActs,
          totalCaloriesBurned: totalBurned,
          topFoods,
          topActivities,
          aggregatedAt: Date.now()
        };

        aggStore.put(aggRecord);
      }

      // Delete raw stale meal records
      const mealStore = tx.objectStore('meal_logs');
      group_delete: for (const meal of staleMeals) {
        if (meal.id) mealStore.delete(meal.id);
        prunedCount++;
      }

      // Delete raw stale activity records
      const actStore = tx.objectStore('activity_logs');
      for (const act of staleActs) {
        if (act.id) actStore.delete(act.id);
        prunedCount++;
      }

      tx.oncomplete = () => {
        console.log(`[IndexedDB Rolling Aggregation] Aggregated & pruned ${prunedCount} records older than 9 months into compact monthly summaries.`);
        resolve(prunedCount);
      };

      tx.onerror = () => resolve(0);
    });
  }

  // --- Meal Logs ---
  async addMealLog(log: Omit<LocalMealLog, 'id' | 'timestamp'>): Promise<LocalMealLog> {
    const db = await this.dbPromise;
    const item: LocalMealLog = {
      ...log,
      timestamp: Date.now()
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meal_logs', 'readwrite');
      const store = tx.objectStore('meal_logs');
      const req = store.add(item);
      req.onsuccess = (e) => {
        item.id = (e.target as IDBRequest<number>).result;
        resolve(item);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getMealLogs(userId: string): Promise<LocalMealLog[]> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction('meal_logs', 'readonly');
      const store = tx.objectStore('meal_logs');
      const idx = store.index('userId');
      const req = idx.getAll(userId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  // --- Activity Logs ---
  async addActivityLog(log: Omit<LocalActivityLog, 'id' | 'timestamp'>): Promise<LocalActivityLog> {
    const db = await this.dbPromise;
    const item: LocalActivityLog = {
      ...log,
      timestamp: Date.now()
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction('activity_logs', 'readwrite');
      const store = tx.objectStore('activity_logs');
      const req = store.add(item);
      req.onsuccess = (e) => {
        item.id = (e.target as IDBRequest<number>).result;
        resolve(item);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getActivityLogs(userId: string): Promise<LocalActivityLog[]> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction('activity_logs', 'readonly');
      const store = tx.objectStore('activity_logs');
      const idx = store.index('userId');
      const req = idx.getAll(userId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  // --- User Profile ---
  async saveUserProfile(profile: LocalUserProfile): Promise<void> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('user_profile', 'readwrite');
      const store = tx.objectStore('user_profile');
      const req = store.put({ ...profile, updatedAt: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getUserProfile(userId: string): Promise<LocalUserProfile | null> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction('user_profile', 'readonly');
      const store = tx.objectStore('user_profile');
      const req = store.get(userId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  // --- Recommendations Cache ---
  async saveRecommendation(userId: string, weekOffset: number, markdownText: string): Promise<void> {
    const db = await this.dbPromise;
    const item: LocalRecommendation = {
      userId,
      weekOffset,
      markdownText,
      generatedAt: Date.now()
    };
    return new Promise((resolve) => {
      const tx = db.transaction('recommendations', 'readwrite');
      const store = tx.objectStore('recommendations');
      store.put(item);
      tx.oncomplete = () => resolve();
    });
  }

  async getRecommendation(userId: string, weekOffset: number): Promise<LocalRecommendation | null> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction('recommendations', 'readonly');
      const store = tx.objectStore('recommendations');
      const req = store.get([userId, weekOffset]);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  // --- Monthly Aggregates ---
  async getMonthlyAggregates(userId: string): Promise<LocalMonthlyAggregate[]> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction('monthly_aggregates', 'readonly');
      const store = tx.objectStore('monthly_aggregates');
      const idx = store.index('userId');
      const req = idx.getAll(userId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  // --- Negative Predictions ---
  async addNegativePrediction(userId: string, foodName: string): Promise<void> {
    const db = await this.dbPromise;
    const cleanFood = foodName.trim().toLowerCase();
    const item: LocalNegativePrediction = {
      userId,
      foodName: cleanFood,
      rejectedAt: Date.now()
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction('negative_predictions', 'readwrite');
      const store = tx.objectStore('negative_predictions');
      store.put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getNegativePredictions(userId: string): Promise<string[]> {
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction('negative_predictions', 'readonly');
      const store = tx.objectStore('negative_predictions');
      const idx = store.index('userId');
      const req = idx.getAll(userId);
      req.onsuccess = () => {
        const results: LocalNegativePrediction[] = req.result || [];
        resolve(results.map(r => r.foodName));
      };
      req.onerror = () => resolve([]);
    });
  }

  // --- Backup Export / Import with Gzip Stream Compression ---
  async exportBackup(userId: string): Promise<string> {
    const meals = await this.getMealLogs(userId);
    const activities = await this.getActivityLogs(userId);
    const profile = await this.getUserProfile(userId);
    const monthlyAggregates = await this.getMonthlyAggregates(userId);
    const backupData = {
      version: 2,
      exportedAt: new Date().toISOString(),
      userId,
      profile,
      meals,
      activities,
      monthlyAggregates
    };
    return JSON.stringify(backupData, null, 2);
  }

  /**
   * Compresses 9 months of JSON backup into a Gzip binary blob (.json.gz) using Web CompressionStream
   */
  async exportCompressedBackup(userId: string): Promise<Blob> {
    const rawJson = await this.exportBackup(userId);
    const jsonBlob = new Blob([rawJson], { type: 'application/json' });

    if ('CompressionStream' in window) {
      const stream = jsonBlob.stream().pipeThrough(new CompressionStream('gzip'));
      return await new Response(stream).blob();
    }
    return jsonBlob;
  }

  /**
   * Decompresses and restores a Gzip compressed backup file (.json.gz) using Web DecompressionStream
   */
  async importCompressedBackup(file: File | Blob): Promise<boolean> {
    try {
      let jsonString = '';
      const fileName = 'name' in file ? (file as File).name : '';
      if ('DecompressionStream' in window && fileName.endsWith('.gz')) {
        const decompressedStream = file.stream().pipeThrough(new DecompressionStream('gzip'));
        jsonString = await new Response(decompressedStream).text();
      } else {
        jsonString = await file.text();
      }
      return await this.importBackup(jsonString);
    } catch (err) {
      console.error('Compressed import failed:', err);
      return false;
    }
  }

  async importBackup(jsonString: string): Promise<boolean> {
    try {
      const data = JSON.parse(jsonString);
      if (!data.meals || !data.activities) return false;
      
      const userId = data.userId || 'default_user';
      if (data.profile) {
        await this.saveUserProfile({ ...data.profile, userId });
      }
      for (const meal of data.meals) {
        await this.addMealLog({ ...meal, userId });
      }
      for (const act of data.activities) {
        await this.addActivityLog({ ...act, userId });
      }
      if (data.monthlyAggregates && Array.isArray(data.monthlyAggregates)) {
        const db = await this.dbPromise;
        const tx = db.transaction('monthly_aggregates', 'readwrite');
        const store = tx.objectStore('monthly_aggregates');
        for (const agg of data.monthlyAggregates) {
          store.put({ ...agg, userId });
        }
      }
      return true;
    } catch (e) {
      console.error('Import failed:', e);
      return false;
    }
  }
}
