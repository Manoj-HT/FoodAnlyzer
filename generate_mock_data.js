const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Paths to data files
const mealLogsPath = path.join(__dirname, 'backend', 'meal_logs.json');
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

// Default times for periods
const times = {
  morning: "08:30",
  noon: "13:15",
  evening: "18:45",
  lateNight: "23:15"
};

function main() {
  console.log("=== Generating 1 Month of Mock Meal Data ===");

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

  // 2. Read or initialize Meal Logs
  let mealLogsData = {};
  if (fs.existsSync(mealLogsPath)) {
    try {
      const rawLogs = fs.readFileSync(mealLogsPath, 'utf8');
      mealLogsData = JSON.parse(rawLogs);
    } catch (err) {
      console.warn("Could not parse existing meal logs. Starting fresh.");
      mealLogsData = {};
    }
  }

  // 3. Generate data for each user
  for (const userId of userIds) {
    console.log(`Generating logs for user: ${usersData[userId].name || userId}...`);

    // Reset caches for this user to force backend to compile fresh report and LLM insights
    usersData[userId].report_cache = {};
    usersData[userId].insights = [];
    usersData[userId].last_insight_generated_time = "";
    usersData[userId].insight_version = 0;

    const userLogs = [];

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
      // We skip exactly one meal slot per day during the last 7 days
      let skipPeriod = null;
      if (dayOffset < 7) {
        // Deterministic skip logic based on dayOffset
        if (dayOffset === 0) skipPeriod = "lateNight";
        else if (dayOffset === 1) skipPeriod = "morning";
        else if (dayOffset === 2) skipPeriod = "noon";
        else if (dayOffset === 3) skipPeriod = "evening";
        else if (dayOffset === 4) skipPeriod = "lateNight";
        else if (dayOffset === 5) skipPeriod = "morning";
        else if (dayOffset === 6) skipPeriod = "noon";
      }

      const periods = ["morning", "noon", "evening", "lateNight"];

      for (const p of periods) {
        // Skip if this period is marked for skipping in active week
        if (p === skipPeriod) {
          continue;
        }

        const meal = foodSource[p];
        const timeStr = `${dateStr}T${times[p]}`;

        userLogs.push({
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
    }

    // Sort user logs by time
    userLogs.sort((a, b) => a.time.localeCompare(b.time));
    mealLogsData[userId] = userLogs;
    console.log(`Generated ${userLogs.length} logs for ${usersData[userId].name || userId}.`);
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

  console.log("=== Mock Data Generation Complete! ===");
}

main();
