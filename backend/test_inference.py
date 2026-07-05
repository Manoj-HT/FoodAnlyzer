import unittest
from datetime import datetime, timedelta
from fastapi.testclient import TestClient

import main
from main import app, MEAL_LOGS, NEGATIVE_PREDICTIONS, USERS_BY_ID, MealLogReport

class TestMealLogInference(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.test_user_id = "test_user_123"
        # Populate dummy user info
        USERS_BY_ID[self.test_user_id] = {
            "id": self.test_user_id,
            "email": "test@example.com",
            "name": "Test User",
            "password": "hashed_password"
        }
        # Reset logs and negative predictions
        MEAL_LOGS[self.test_user_id] = []
        NEGATIVE_PREDICTIONS[self.test_user_id] = []

    def tearDown(self):
        # Cleanup mock user data
        if self.test_user_id in USERS_BY_ID:
            del USERS_BY_ID[self.test_user_id]
        if self.test_user_id in MEAL_LOGS:
            del MEAL_LOGS[self.test_user_id]
        if self.test_user_id in NEGATIVE_PREDICTIONS:
            del NEGATIVE_PREDICTIONS[self.test_user_id]

    def test_low_data_warning(self):
        # Under 21 logs (e.g. 5 logs)
        for i in range(5):
            MEAL_LOGS[self.test_user_id].append({
                "id": f"log_{i}",
                "description": "apple",
                "time": (datetime.now() - timedelta(days=i+10)).replace(hour=8, minute=0).isoformat(),
                "report": MealLogReport(calories=50, protein=0, carbs=14, fat=0, grade="A").dict()
            })
        
        response = self.client.get(f"/api/users/{self.test_user_id}/inferred-logs?week_offset=0")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data["low_data"])
        self.assertEqual(len(data["inferred_logs"]), 0)

    def test_inference_tiers(self):
        # Populate history with 21 logs to meet threshold
        # We want to check Tier 1: Day of week + Period match.
        # Let's say today is Monday. The active week ends today (offset 0).
        # Historical Mondays had 'Idli Sambar' at 8:00 AM (morning).
        # Other historical days had 'Oats' in the morning.
        
        now = datetime.now()
        # Find a previous Monday in history (e.g. 2 weeks ago)
        # weekday(): Monday is 0, Sunday is 6
        days_to_monday = now.weekday()
        target_monday = now - timedelta(days=days_to_monday + 14) # Monday 2 weeks ago
        
        # Log 21+ meals in the past, but skip Mondays for Oats
        for i in range(25):
            log_time = now - timedelta(days=i+10)
            if log_time.weekday() == 0:
                continue
            MEAL_LOGS[self.test_user_id].append({
                "id": f"hist_{i}",
                "description": "Oats",
                "time": log_time.replace(hour=9, minute=0).isoformat(),
                "report": MealLogReport(calories=150, protein=5, carbs=27, fat=3, grade="A").dict()
            })
            
        # Log specific Monday breakfast 2 weeks ago
        MEAL_LOGS[self.test_user_id].append({
            "id": "monday_breakfast",
            "description": "Idli Sambar",
            "time": target_monday.replace(hour=8, minute=30).isoformat(),
            "report": MealLogReport(calories=200, protein=6, carbs=40, fat=2, grade="B").dict()
        })
        
        # Now run inference for active week (week_offset=0)
        response = self.client.get(f"/api/users/{self.test_user_id}/inferred-logs?week_offset=0")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertFalse(data["low_data"])
        
        # Let's look at the inferred logs for Monday of this week
        monday_this_week = (now - timedelta(days=now.weekday())).date().isoformat()
        monday_morning_inferred = [
            log for log in data["inferred_logs"]
            if log["time"].startswith(monday_this_week) and log["timePeriod"] == "morning"
        ]
        
        # Since weekday matching is Tier 1, it should suggest "Idli Sambar" instead of "Oats"
        self.assertTrue(len(monday_morning_inferred) > 0)
        self.assertEqual(monday_morning_inferred[0]["description"], "Idli Sambar")
        # Time predicted should be historical average (8:30)
        self.assertIn("08:30", monday_morning_inferred[0]["time"])

    def test_negative_predictions_and_feedback(self):
        # Add 21 logs
        now = datetime.now()
        for i in range(21):
            MEAL_LOGS[self.test_user_id].append({
                "id": f"hist_{i}",
                "description": "Oats",
                "time": (now - timedelta(days=i+10)).replace(hour=9, minute=0).isoformat(),
                "report": MealLogReport(calories=150, protein=5, carbs=27, fat=3, grade="A").dict()
            })
            
        # Get inferences first
        response = self.client.get(f"/api/users/{self.test_user_id}/inferred-logs?week_offset=0")
        self.assertEqual(response.status_code, 200)
        inferred = response.json()["inferred_logs"]
        self.assertTrue(len(inferred) > 0)
        
        target_meal = inferred[0]
        # Let's send a "no" feedback
        payload = {
            "date": target_meal["time"].split("T")[0],
            "time_period": target_meal["timePeriod"],
            "description": target_meal["description"],
            "feedback": "no",
            "time": target_meal["time"]
        }
        res_no = self.client.post(f"/api/users/{self.test_user_id}/inferred-logs/feedback", json=payload)
        self.assertEqual(res_no.status_code, 200)
        self.assertEqual(res_no.json()["status"], "success")
        
        # Verify it is in negative predictions
        self.assertEqual(len(NEGATIVE_PREDICTIONS[self.test_user_id]), 1)
        self.assertEqual(NEGATIVE_PREDICTIONS[self.test_user_id][0]["description"], target_meal["description"])
        
        # Verify that this inference is now excluded
        response_new = self.client.get(f"/api/users/{self.test_user_id}/inferred-logs?week_offset=0")
        inferred_new = response_new.json()["inferred_logs"]
        matched_inferences = [
            m for m in inferred_new
            if m["time"] == target_meal["time"] and m["description"] == target_meal["description"]
        ]
        self.assertEqual(len(matched_inferences), 0)
        
        # Now click "yes" on the same suggestion (to test the change-mind/override flow)
        payload["feedback"] = "yes"
        res_yes = self.client.post(f"/api/users/{self.test_user_id}/inferred-logs/feedback", json=payload)
        self.assertEqual(res_yes.status_code, 200)
        
        # Verify negative prediction is deleted
        self.assertEqual(len(NEGATIVE_PREDICTIONS[self.test_user_id]), 0)
        # Verify it is logged as an actual meal in MEAL_LOGS
        user_logs = MEAL_LOGS[self.test_user_id]
        newly_logged = [m for m in user_logs if m["time"] == target_meal["time"] and m["description"] == target_meal["description"]]
        self.assertEqual(len(newly_logged), 1)

if __name__ == '__main__':
    unittest.main()
