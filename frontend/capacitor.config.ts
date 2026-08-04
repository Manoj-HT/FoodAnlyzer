import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.foodanalyzer.app',
  appName: 'FoodAnalyzer',
  webDir: 'dist/frontend-app/browser',
  server: {
    androidScheme: 'https'
  }
};

export default config;
