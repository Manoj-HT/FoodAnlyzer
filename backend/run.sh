#!/bin/bash
set -e

# Change directory to backend folder location
cd "$(dirname "$0")"

echo "=== FoodAnalyzer Backend Setup ==="

# Check if virtual environment exists, if not, create it
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Upgrade pip and install requirements
echo "Installing/updating dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

echo "Starting Uvicorn server on port 8000..."
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
