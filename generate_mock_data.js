const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Paths to data files
const mealLogsPath = path.join(__dirname, 'backend', 'meal_logs.json');
const activityLogsPath = path.join(__dirname, 'backend', 'activity_logs.json');
const usersPath = path.join(__dirname, 'backend', 'users.json');

// Standard Food Recipes with nutritional details
const weekdayFoods = {
  morning: { description: "idli sambar", calories: 180, protein: 6, carbs: 34, fat: 2, grade: "A" },
  noon: { description: "dal rice", calories: 320, protein: 11, carbs: 55, fat: 5, grade: "A" },
  evening: { description: "fruit salad", calories: 120, protein: 2, carbs: 28, fat: 0, grade: "A" },
  lateNight: { description: "roti sabzi", calories: 260, protein: 8, carbs: 40, fat: 6, grade: "A" }
};

const weekendFoods = {
  morning: { description: "oatmeal", calories: 150, protein: 5, carbs: 27, fat: 3, grade: "A" },
  noon: { description: "veg biryani", calories: 380, protein: 9, carbs: 60, fat: 11, grade: "B" },
  evening: { description: "sandwich", calories: 250, protein: 8, carbs: 30, fat: 9, grade: "B" },
  lateNight: { description: "pasta", calories: 380, protein: 12, carbs: 55, fat: 9, grade: "B" }
};

// Standard Physical Activity Templates with Task-wise Breakdowns
const activityTemplates = [
  {
    clean_title: "Strength Training / Gym (Bench Press, Squats, Deadlift)",
    calories_burned: 260,
    duration_minutes: 60,
    intensity: "High",
    activity_type: "Strength Training / Gym",
    time: "17:30",
    tasks: [
      { task: "Bench Press", details: "3 sets", calories_burned: 85 },
      { task: "Squats", details: "3 sets", calories_burned: 115 },
      { task: "Deadlift", details: "1 rep max", calories_burned: 60 }
    ],
    tips: [
      "High energy burn session! Be sure to replenish water and electrolytes.",
      "Pair with high quality protein within 90 minutes to aid muscle repair."
    ]
  },
  {
    clean_title: "Outdoor Running (Tempo Run & Cool Down)",
    calories_burned: 340,
    duration_minutes: 35,
    intensity: "High",
    activity_type: "Running",
    time: "07:00",
    tasks: [
      { task: "Warmup Jog", details: "5 mins", calories_burned: 40 },
      { task: "Tempo Running", details: "25 mins", calories_burned: 270 },
      { task: "Cool Down Walk", details: "5 mins", calories_burned: 30 }
    ],
    tips: [
      "Excellent tempo run! Keep hydrated with water and electrolytes."
    ]
  },
  {
    clean_title: "Outdoor Cycling (Interval Sprints)",
    calories_burned: 290,
    duration_minutes: 45,
    intensity: "Moderate",
    activity_type: "Cycling",
    time: "18:15",
    tasks: [
      { task: "Steady Pacing", details: "30 mins", calories_burned: 190 },
      { task: "Hills & Sprints", details: "15 mins", calories_burned: 100 }
    ],
    tips: [
      "Excellent leg endurance training. Maintain steady breathing."
    ]
  },
  {
    clean_title: "Brisk Evening Walk (Park Loop)",
    calories_burned: 180,
    duration_minutes: 45,
    intensity: "Moderate",
    activity_type: "Walking",
    time: "19:00",
    tasks: [
      { task: "Park Loop Walk", details: "45 mins", calories_burned: 180 }
    ],
    tips: [
      "Consistent low-impact activity helps burn fat and boost mood."
    ]
  },
  {
    clean_title: "HIIT & Core Workout (Burpees, Plank, Mountain Climbers)",
    calories_burned: 310,
    duration_minutes: 40,
    intensity: "High",
    activity_type: "HIIT",
    time: "07:30",
    tasks: [
      { task: "Burpees & Sprints", details: "15 mins", calories_burned: 140 },
      { task: "Plank & Core Circuits", details: "15 mins", calories_burned: 110 },
      { task: "Stretching & Recovery", details: "10 mins", calories_burned: 60 }
    ],
    tips: [
      "High intensity interval training burns post-workout calories for hours!"
    ]
  }
];

// Default times for periods
const times = {
  morning: "08:30",
  noon: "13:15",
  evening: "18:45",
  lateNight: "23:15"
};

function main() {
  console.log("=== Generating 1 Month of Mock Meal & Activity Data ===");

  if (!fs.existsSync(usersPath)) {
    console.error(`Users file not found at: ${usersPath}`);
    process.exit(1);
  }

  // 1. Read Users
  let usersData = {};
  try {
    const rawUsers = fs.readFileSync(usersPath, 'utf8');
    usersData = JSON.parse(rawUsers);
  } catch (err) {
    console.error(`Error reading users.json: ${err.message}`);
    process.exit(1);
  }

  const userIds = Object.keys(usersData);
  if (userIds.length === 0) {
    console.warn("No users found in users.json to generate data for.");
    process.exit(0);
  }

  console.log(`Found users: ${userIds.join(', ')}`);

  // 2. Read or initialize Meal & Activity Logs
  let mealLogsData = {};
  let activityLogsData = {};

  if (fs.existsSync(mealLogsPath)) {
    try {
      const rawMealLogs = fs.readFileSync(mealLogsPath, 'utf8');
      mealLogsData = JSON.parse(rawMealLogs);
    } catch (err) {
      console.warn("Could not parse existing meal logs. Starting fresh.");
      mealLogsData = {};
    }
  }

  if (fs.existsSync(activityLogsPath)) {
    try {
      const rawActLogs = fs.readFileSync(activityLogsPath, 'utf8');
      activityLogsData = JSON.parse(rawActLogs);
    } catch (err) {
      console.warn("Could not parse existing activity logs. Starting fresh.");
      activityLogsData = {};
    }
  }

  // 3. Generate data for each user
  for (const userId of userIds) {
    console.log(`Generating meal & activity logs for user: ${usersData[userId].name || userId}...`);

    // Reset caches for this user to force backend to compile fresh report and LLM insights
    usersData[userId].report_cache = {};
    usersData[userId].insights = [];
    usersData[userId].last_insight_generated_time = "";
    usersData[userId].insight_version = 0;

    const userMealLogs = [];
    const userActivityLogs = [];

    // Generate 30 days of data (Day -29 to Day 0)
    for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
      const date = new Date();
      date.setDate(date.getDate() - dayOffset);

      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
      const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
      const foodSource = isWeekend ? weekendFoods : weekdayFoods;

      // Determine skipped meals in the active week (Day 0 to Day 6)
      let skipPeriod = null;
      if (dayOffset < 7) {
        if (dayOffset === 0) skipPeriod = "lateNight";
        else if (dayOffset === 1) skipPeriod = "morning";
        else if (dayOffset === 2) skipPeriod = "noon";
        else if (dayOffset === 3) skipPeriod = "evening";
        else if (dayOffset === 4) skipPeriod = "lateNight";
        else if (dayOffset === 5) skipPeriod = "morning";
        else if (dayOffset === 6) skipPeriod = "noon";
      }

      const periods = ["morning", "noon", "evening", "lateNight"];

      // Generate Meals
      for (const p of periods) {
        if (p === skipPeriod) {
          continue;
        }

        const meal = foodSource[p];
        const timeStr = `${dateStr}T${times[p]}`;

        userMealLogs.push({
          id: crypto.randomUUID(),
          description: meal.description,
          time: timeStr,
          report: {
            calories: meal.calories,
            protein: meal.protein,
            carbs: meal.carbs,
            fat: meal.fat,
            grade: meal.grade
          }
        });
      }

      // Generate Physical Activity (5 out of 7 days)
      if (dayOffset % 7 !== 2 && dayOffset % 7 !== 5) {
        const actTemplate = activityTemplates[dayOffset % activityTemplates.length];
        const actTimeStr = `${dateStr}T${actTemplate.time}`;

        userActivityLogs.push({
          id: `act-${dateStr}-${dayOffset}`,
          description: actTemplate.clean_title,
          time: actTimeStr,
          report: {
            clean_title: actTemplate.clean_title,
            calories_burned: actTemplate.calories_burned,
            duration_minutes: actTemplate.duration_minutes,
            intensity: actTemplate.intensity,
            activity_type: actTemplate.activity_type,
            tasks: actTemplate.tasks,
            tips: actTemplate.tips
          }
        });
      }
    }

    // Sort user logs by time
    userMealLogs.sort((a, b) => a.time.localeCompare(b.time));
    userActivityLogs.sort((a, b) => a.time.localeCompare(b.time));

    mealLogsData[userId] = userMealLogs;
    activityLogsData[userId] = userActivityLogs;

    console.log(`Generated ${userMealLogs.length} meal logs & ${userActivityLogs.length} activity logs for ${usersData[userId].name || userId}.`);
  }

  // 4. Save users.json (with cleared caches)
  try {
    fs.writeFileSync(usersPath, JSON.stringify(usersData, null, 4), 'utf8');
    console.log("Successfully updated backend/users.json (caches cleared).");
  } catch (err) {
    console.error(`Failed to write users.json: ${err.message}`);
    process.exit(1);
  }

  // 5. Save meal_logs.json
  try {
    fs.writeFileSync(mealLogsPath, JSON.stringify(mealLogsData, null, 4), 'utf8');
    console.log("Successfully updated backend/meal_logs.json.");
  } catch (err) {
    console.error(`Failed to write meal_logs.json: ${err.message}`);
    process.exit(1);
  }

  // 6. Save activity_logs.json
  try {
    fs.writeFileSync(activityLogsPath, JSON.stringify(activityLogsData, null, 4), 'utf8');
    console.log("Successfully updated backend/activity_logs.json.");
  } catch (err) {
    console.error(`Failed to write activity_logs.json: ${err.message}`);
    process.exit(1);
  }

  console.log("=== Mock Data Generation Complete! ===");
}

main();
