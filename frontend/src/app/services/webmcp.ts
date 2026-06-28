import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth';
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';

@Injectable({
  providedIn: 'root',
})
export class WebMcpService {
  private readonly authService = inject(AuthService);

  constructor() {
    this.initWebMCP();
  }

  private initWebMCP(): void {
    try {
      // Initialize the polyfill
      initializeWebMCPPolyfill();

      // Check for document.modelContext or navigator.modelContext
      const modelContext = (document as any).modelContext || (navigator as any).modelContext;

      if (!modelContext) {
        console.warn('WebMCP context not available even after polyfill initialization.');
        return;
      }

      console.log('WebMCP initialized successfully, registering tools...');

      // 1. get_user_info
      modelContext.registerTool({
        name: 'get_user_info',
        description: "Retrieves the logged-in user's profile details (name, email, current health goals/bio).",
        inputSchema: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const userid = this.authService.getUserId();
          if (!userid) {
            return {
              content: [{ type: 'text', text: 'Error: User is not logged in.' }],
            };
          }
          try {
            const user = await firstValueFrom(this.authService.getUserDetails(userid));
            return {
              content: [
                {
                  type: 'text',
                  text: `User Profile Info:\nID: ${user.id}\nEmail: ${user.email}\nName: ${user.name || 'Member'}\nBio/Details: ${user.userdetails || 'None'}`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [{ type: 'text', text: `Error fetching user details: ${err.message || err}` }],
            };
          }
        },
      });

      // 2. get_meal_logs
      modelContext.registerTool({
        name: 'get_meal_logs',
        description: "Fetches the user's meal logs for a specific week offset (0 for current week, 1 for previous week, etc.).",
        inputSchema: {
          type: 'object',
          properties: {
            week_offset: {
              type: 'number',
              description: 'Offset in weeks. 0 for current week, 1 for previous week, etc.',
            },
          },
        },
        execute: async (args: any) => {
          const userid = this.authService.getUserId();
          if (!userid) {
            return {
              content: [{ type: 'text', text: 'Error: User is not logged in.' }],
            };
          }
          const weekOffset = typeof args.week_offset === 'number' ? args.week_offset : 0;
          try {
            const logs = await firstValueFrom(this.authService.getMealLogs(userid, weekOffset));
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(logs, null, 2),
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [{ type: 'text', text: `Error fetching meal logs: ${err.message || err}` }],
            };
          }
        },
      });

      // 3. add_meal_log
      modelContext.registerTool({
        name: 'add_meal_log',
        description: 'Logs a new meal using natural language (e.g. "I ate idly and sambhar at 9am today"). The system will automatically extract the food eaten, date, time, and calculate nutrients before logging.',
        inputSchema: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'The natural language description of the meal eaten, including optional time/date details.',
            },
          },
          required: ['description'],
        },
        execute: async (args: any) => {
          const userid = this.authService.getUserId();
          if (!userid) {
            return {
              content: [{ type: 'text', text: 'Error: User is not logged in.' }],
            };
          }

          const { description } = args;

          try {
            const result = await firstValueFrom(
              this.authService.addMealLog(userid, { description })
            );
            const log = result.log;
            return {
              content: [
                {
                  type: 'text',
                  text: `Successfully logged meal!\n\nDetails:\n- Food logged: ${log.description}\n- Eaten at: ${log.time}\n- Calories: ${log.report.calories} kcal\n- Protein: ${log.report.protein}g\n- Carbs: ${log.report.carbs}g\n- Fat: ${log.report.fat}g\n- Health Grade: ${log.report.grade}`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [{ type: 'text', text: `Error logging meal: ${err.message || err}` }],
            };
          }
        },
      });

      // 4. get_recommendations
      modelContext.registerTool({
        name: 'get_recommendations',
        description: 'Gets personalized dietary recommendations for the user based on their profile and logs.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const userid = this.authService.getUserId();
          if (!userid) {
            return {
              content: [{ type: 'text', text: 'Error: User is not logged in.' }],
            };
          }
          try {
            const recommendations = await firstValueFrom(this.authService.getRecommendations(userid));
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(recommendations, null, 2),
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [{ type: 'text', text: `Error fetching recommendations: ${err.message || err}` }],
            };
          }
        },
      });

      // 5. analyze_food
      modelContext.registerTool({
        name: 'analyze_food',
        description: 'Analyzes a food description to return its nutritional breakdown (calories, protein, carbs, fat, grade, tips).',
        inputSchema: {
          type: 'object',
          properties: {
            food_name: {
              type: 'string',
              description: 'The description or name of the food to analyze.',
            },
          },
          required: ['food_name'],
        },
        execute: async (args: any) => {
          const { food_name } = args;
          try {
            const result = await firstValueFrom(this.authService.analyzeFood(food_name));
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [{ type: 'text', text: `Error analyzing food: ${err.message || err}` }],
            };
          }
        },
      });

      // 6. update_user_bio
      modelContext.registerTool({
        name: 'update_user_bio',
        description: "Updates the user's bio/details (e.g. age, weight, height, health conditions, or goals).",
        inputSchema: {
          type: 'object',
          properties: {
            modifications: {
              type: 'string',
              description: 'The new details or changes to add to the profile.',
            },
          },
          required: ['modifications'],
        },
        execute: async (args: any) => {
          const userid = this.authService.getUserId();
          if (!userid) {
            return {
              content: [{ type: 'text', text: 'Error: User is not logged in.' }],
            };
          }
          const { modifications } = args;
          try {
            const res = await firstValueFrom(this.authService.updateDetails(userid, modifications));
            return {
              content: [
                {
                  type: 'text',
                  text: `Profile updated successfully. Updated Bio/Details: ${res.userdetails}`,
                },
              ],
            };
          } catch (err: any) {
            return {
              content: [{ type: 'text', text: `Error updating details: ${err.message || err}` }],
            };
          }
        },
      });

      console.log('WebMCP tools registered.');
    } catch (err) {
      console.error('Failed to initialize WebMCP:', err);
    }
  }
}
