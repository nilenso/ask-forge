#!/usr/bin/env python3
"""
Review server for human-in-the-loop feedback on test results.

Provides a web UI to:
- List all test runs
- Review responses and fact verifications
- Compare LLM judgments with human judgments
- Track accuracy metrics over time

Usage:
    python review-server.py [port]
    
Default port: 5000
"""

import json
import os
from datetime import datetime
import subprocess
from flask import Flask, render_template, jsonify, request

app = Flask(__name__)

REPORTS_DIR = "reports"
RUNS_DIR = os.path.join(REPORTS_DIR, "runs")
REVIEWS_DIR = os.path.join(REPORTS_DIR, "reviews")


def get_all_runs():
    """Get all test runs from the runs directory."""
    runs = []
    if not os.path.exists(RUNS_DIR):
        return runs
    
    for filename in os.listdir(RUNS_DIR):
        if filename.endswith(".json"):
            filepath = os.path.join(RUNS_DIR, filename)
            try:
                with open(filepath) as f:
                    data = json.load(f)
                    progress = data.get("progress", {})
                    runs.append({
                        "id": data.get("id", filename.replace(".json", "")),
                        "agent_name": data.get("agent_name", "unknown"),
                        "timestamp": data.get("timestamp", ""),
                        "status": data.get("status", "complete"),
                        "progress_completed": progress.get("completed", data.get("summary", {}).get("total_examples", 0)),
                        "progress_total": progress.get("total", data.get("summary", {}).get("total_examples", 0)),
                        "total_examples": data.get("summary", {}).get("total_examples", 0),
                        "total_facts": data.get("summary", {}).get("total_facts", 0),
                        "llm_verified_facts": data.get("summary", {}).get("llm_verified_facts", 0),
                        "accuracy": data.get("summary", {}).get("accuracy", 0),
                    })
            except (json.JSONDecodeError, IOError) as e:
                print(f"Error loading {filename}: {e}")
    
    # Sort by timestamp descending
    runs.sort(key=lambda x: x["timestamp"], reverse=True)
    return runs


def get_run(run_id):
    """Get a specific test run by ID."""
    filepath = os.path.join(RUNS_DIR, f"{run_id}.json")
    if not os.path.exists(filepath):
        return None
    
    with open(filepath) as f:
        return json.load(f)


def get_review(run_id):
    """Get the review for a specific run, or return empty review structure."""
    filepath = os.path.join(REVIEWS_DIR, f"{run_id}-review.json")
    if os.path.exists(filepath):
        with open(filepath) as f:
            return json.load(f)
    
    # Return empty review structure
    return {
        "run_id": run_id,
        "reviewed_at": None,
        "reviews": []
    }


def save_review(run_id, review_data):
    """Save review data to file."""
    os.makedirs(REVIEWS_DIR, exist_ok=True)
    filepath = os.path.join(REVIEWS_DIR, f"{run_id}-review.json")
    
    review_data["run_id"] = run_id
    review_data["reviewed_at"] = datetime.now().isoformat()
    
    with open(filepath, "w") as f:
        json.dump(review_data, f, indent=2)


def get_review_status(run_id, total_examples):
    """Get review status for a run."""
    review = get_review(run_id)
    reviewed_count = len([r for r in review.get("reviews", []) if r.get("response_correct") is not None])
    return {
        "reviewed": reviewed_count,
        "total": total_examples,
        "complete": reviewed_count == total_examples
    }


def compute_metrics():
    """Compute accuracy metrics across all reviewed runs."""
    metrics = {
        "total_runs": 0,
        "reviewed_runs": 0,
        "total_examples": 0,
        "reviewed_examples": 0,
        "total_facts": 0,
        "reviewed_facts": 0,
        "response_correct": 0,
        "response_incorrect": 0,
        "llm_true_human_true": 0,   # True Positive
        "llm_true_human_false": 0,  # False Positive
        "llm_false_human_true": 0,  # False Negative
        "llm_false_human_false": 0, # True Negative
        "by_agent": {},
        "by_difficulty": {},
        "by_type": {},
        "runs": [],  # Per-run metrics
    }
    
    runs = get_all_runs()
    metrics["total_runs"] = len(runs)
    
    for run_info in runs:
        run_id = run_info["id"]
        run = get_run(run_id)
        review = get_review(run_id)
        
        if not run:
            continue
        
        reviews_by_index = {r["example_index"]: r for r in review.get("reviews", [])}
        has_reviews = len(reviews_by_index) > 0
        
        if has_reviews:
            metrics["reviewed_runs"] += 1
        
        # Per-run metrics
        run_metrics = {
            "id": run_id,
            "agent_name": run.get("agent_name", "unknown"),
            "status": run.get("status", "complete"),
            "total_examples": len(run.get("examples", [])),
            "reviewed_examples": 0,
            "total_facts": sum(len(ex.get("facts", [])) for ex in run.get("examples", [])),
            "reviewed_facts": 0,
            "response_correct": 0,
            "response_incorrect": 0,
            "review_complete": False,
        }
        
        agent = run.get("agent_name", "unknown")
        if agent not in metrics["by_agent"]:
            metrics["by_agent"][agent] = {"tp": 0, "fp": 0, "fn": 0, "tn": 0, "correct": 0, "incorrect": 0}
        
        for example in run.get("examples", []):
            idx = example["index"]
            metrics["total_examples"] += 1
            metrics["total_facts"] += len(example.get("facts", []))
            
            human_review = reviews_by_index.get(idx)
            if not human_review:
                continue
            
            run_metrics["reviewed_examples"] += 1
            
            metrics["reviewed_examples"] += 1
            
            # Response correctness
            if human_review.get("response_correct") is True:
                metrics["response_correct"] += 1
                metrics["by_agent"][agent]["correct"] += 1
                run_metrics["response_correct"] += 1
            elif human_review.get("response_correct") is False:
                metrics["response_incorrect"] += 1
                metrics["by_agent"][agent]["incorrect"] += 1
                run_metrics["response_incorrect"] += 1
            
            # Fact verdicts
            llm_verdicts = example.get("llm_fact_verdicts", [])
            human_verdicts = human_review.get("fact_verdicts", [])
            
            difficulty = example.get("metadata", {}).get("difficulty", "unknown")
            example_type = example.get("metadata", {}).get("type", "unknown")
            
            if difficulty not in metrics["by_difficulty"]:
                metrics["by_difficulty"][difficulty] = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
            if example_type not in metrics["by_type"]:
                metrics["by_type"][example_type] = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
            
            for i, (llm_v, human_v) in enumerate(zip(llm_verdicts, human_verdicts)):
                if human_v is None:
                    continue
                
                metrics["reviewed_facts"] += 1
                run_metrics["reviewed_facts"] += 1
                
                if llm_v and human_v:
                    metrics["llm_true_human_true"] += 1
                    metrics["by_agent"][agent]["tp"] += 1
                    metrics["by_difficulty"][difficulty]["tp"] += 1
                    metrics["by_type"][example_type]["tp"] += 1
                elif llm_v and not human_v:
                    metrics["llm_true_human_false"] += 1
                    metrics["by_agent"][agent]["fp"] += 1
                    metrics["by_difficulty"][difficulty]["fp"] += 1
                    metrics["by_type"][example_type]["fp"] += 1
                elif not llm_v and human_v:
                    metrics["llm_false_human_true"] += 1
                    metrics["by_agent"][agent]["fn"] += 1
                    metrics["by_difficulty"][difficulty]["fn"] += 1
                    metrics["by_type"][example_type]["fn"] += 1
                else:
                    metrics["llm_false_human_false"] += 1
                    metrics["by_agent"][agent]["tn"] += 1
                    metrics["by_difficulty"][difficulty]["tn"] += 1
                    metrics["by_type"][example_type]["tn"] += 1
        
        # Mark run as complete if all examples reviewed
        run_metrics["review_complete"] = run_metrics["reviewed_examples"] == run_metrics["total_examples"]
        metrics["runs"].append(run_metrics)
    
    # Compute derived metrics
    total_reviewed = metrics["llm_true_human_true"] + metrics["llm_true_human_false"] + \
                     metrics["llm_false_human_true"] + metrics["llm_false_human_false"]
    
    if total_reviewed > 0:
        metrics["llm_accuracy"] = (metrics["llm_true_human_true"] + metrics["llm_false_human_false"]) / total_reviewed * 100
        
        tp = metrics["llm_true_human_true"]
        fp = metrics["llm_true_human_false"]
        fn = metrics["llm_false_human_true"]
        
        metrics["precision"] = tp / (tp + fp) * 100 if (tp + fp) > 0 else 0
        metrics["recall"] = tp / (tp + fn) * 100 if (tp + fn) > 0 else 0
    else:
        metrics["llm_accuracy"] = 0
        metrics["precision"] = 0
        metrics["recall"] = 0
    
    total_responses = metrics["response_correct"] + metrics["response_incorrect"]
    metrics["agent_response_accuracy"] = metrics["response_correct"] / total_responses * 100 if total_responses > 0 else 0
    
    return metrics


# Routes

AVAILABLE_AGENTS = ["ask-forge", "claude"]


@app.route("/")
def index():
    """List all test runs."""
    runs = get_all_runs()
    
    # Add review status to each run
    for run in runs:
        run["review_status"] = get_review_status(run["id"], run["total_examples"])
    
    return render_template("index.html", runs=runs, agents=AVAILABLE_AGENTS)


@app.route("/review/<run_id>")
def review(run_id):
    """Review interface for a specific run."""
    run = get_run(run_id)
    if not run:
        return "Run not found", 404
    
    review_data = get_review(run_id)
    
    return render_template("review.html", run=run, review=review_data)


@app.route("/metrics")
def metrics():
    """Accuracy metrics dashboard."""
    metrics_data = compute_metrics()
    return render_template("metrics.html", metrics=metrics_data)


# API Routes

@app.route("/api/runs")
def api_runs():
    """API: Get all runs."""
    runs = get_all_runs()
    for run in runs:
        run["review_status"] = get_review_status(run["id"], run["total_examples"])
    return jsonify(runs)


@app.route("/api/run/<run_id>")
def api_run(run_id):
    """API: Get a specific run."""
    run = get_run(run_id)
    if not run:
        return jsonify({"error": "Run not found"}), 404
    return jsonify(run)


@app.route("/api/review/<run_id>", methods=["GET"])
def api_get_review(run_id):
    """API: Get review for a run."""
    review = get_review(run_id)
    return jsonify(review)


@app.route("/api/review/<run_id>", methods=["POST"])
def api_save_review(run_id):
    """API: Save review for a run."""
    run = get_run(run_id)
    if not run:
        return jsonify({"error": "Run not found"}), 404
    
    review_data = request.json
    save_review(run_id, review_data)
    
    return jsonify({"success": True, "message": "Review saved"})


@app.route("/api/review/<run_id>/example/<int:example_index>", methods=["POST"])
def api_save_example_review(run_id, example_index):
    """API: Save review for a single example."""
    run = get_run(run_id)
    if not run:
        return jsonify({"error": "Run not found"}), 404
    
    example_review = request.json
    example_review["example_index"] = example_index
    
    # Load existing review
    review = get_review(run_id)
    reviews = review.get("reviews", [])
    
    # Update or add the example review
    found = False
    for i, r in enumerate(reviews):
        if r.get("example_index") == example_index:
            reviews[i] = example_review
            found = True
            break
    
    if not found:
        reviews.append(example_review)
    
    review["reviews"] = reviews
    save_review(run_id, review)
    
    return jsonify({"success": True, "message": "Example review saved"})


@app.route("/api/metrics")
def api_metrics():
    """API: Get accuracy metrics."""
    return jsonify(compute_metrics())


@app.route("/api/run-test", methods=["POST"])
def api_run_test():
    """API: Start a new test run."""
    data = request.json
    agent = data.get("agent", "ask-forge")
    num_examples = data.get("num_examples", 5)
    
    # Validate agent
    if agent not in AVAILABLE_AGENTS:
        return jsonify({"success": False, "error": f"Unknown agent: {agent}"}), 400
    
    # Validate num_examples
    try:
        num_examples = int(num_examples)
        if num_examples < 1 or num_examples > 100:
            raise ValueError("num_examples must be between 1 and 100")
    except (ValueError, TypeError) as e:
        return jsonify({"success": False, "error": str(e)}), 400
    
    # Run test-dataset.py in background
    try:
        cmd = ["python", "test-dataset.py", str(num_examples), agent]
        subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True
        )
        return jsonify({
            "success": True,
            "message": f"Test started: {num_examples} examples with {agent}"
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
    
    print(f"Starting review server on http://localhost:{port}")
    print(f"Reports directory: {os.path.abspath(REPORTS_DIR)}")
    print()
    print("Press Ctrl+C to stop")
    
    app.run(debug=True, port=port)
