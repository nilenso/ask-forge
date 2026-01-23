#!/usr/bin/env python3
"""
Test code agents using the deep_code_bench dataset from Hugging Face.
Verifies if facts from the dataset are represented in agent responses.

Usage:
    python test-dataset.py [num_examples]
    
Examples:
    python test-dataset.py 5
    python test-dataset.py 10
"""

import subprocess
import json
import sys
import os
import re
import html
from abc import ABC, abstractmethod
from datetime import datetime
from dataclasses import dataclass, field
from datasets import load_dataset
from dotenv import load_dotenv

# Load environment variables from .env file (in parent directory)
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

# Import configuration
import config


@dataclass
class ExampleResult:
    """Stores the result of testing a single example."""
    index: int
    repo_url: str
    commit: str
    question: str
    facts: list[str]
    response: str
    verified_facts: list[tuple[str, bool]]
    metadata: dict
    passed: bool


@dataclass 
class TestResults:
    """Stores all test results for report generation."""
    agent_name: str
    timestamp: str
    examples: list[ExampleResult] = field(default_factory=list)
    results_by_type: dict = field(default_factory=dict)
    results_by_difficulty: dict = field(default_factory=dict)
    results_by_scope: dict = field(default_factory=dict)
    
    @property
    def total_examples(self) -> int:
        return len(self.examples)
    
    @property
    def passed_examples(self) -> int:
        return sum(1 for e in self.examples if e.passed)
    
    @property
    def total_facts(self) -> int:
        return sum(len(e.facts) for e in self.examples)
    
    @property
    def verified_facts(self) -> int:
        return sum(sum(1 for _, v in e.verified_facts if v) for e in self.examples)
    
    @property
    def accuracy(self) -> float:
        return self.verified_facts / self.total_facts * 100 if self.total_facts > 0 else 0


class Agent(ABC):
    """Abstract base class for code agents."""
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Return the agent name."""
        pass
    
    @abstractmethod
    def ask(self, repo_url: str, question: str, commit: str) -> str:
        """Ask the agent a question about a repo and return the response."""
        pass


class AskForgeAgent(Agent):
    """Ask-forge agent that uses local bun runtime."""
    
    def __init__(self):
        # Path to the parent directory where ask.ts lives
        self.project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    @property
    def name(self) -> str:
        return "ask-forge"
    
    def ask(self, repo_url: str, question: str, commit: str) -> str:
        try:
            env = os.environ.copy()
            result = subprocess.run(
                ["bun", "run", "ask.ts", repo_url, question, commit],
                capture_output=True,
                text=True,
                timeout=300,
                env=env,
                cwd=self.project_root
            )
            
            stdout = result.stdout
            json_start = stdout.rfind('{\n  "prompt"')
            if json_start == -1:
                json_start = stdout.rfind('{"prompt"')
            
            if json_start != -1:
                json_str = stdout[json_start:]
                try:
                    data = json.loads(json_str)
                    return data.get("response", "[ERROR: No 'response' field in JSON output]")
                except json.JSONDecodeError as e:
                    response_match = re.search(r'"response":\s*"((?:[^"\\]|\\.)*)"\s*\}', json_str)
                    if response_match:
                        return response_match.group(1).encode().decode('unicode_escape')
                    error_msg = f"[ERROR: Failed to parse JSON response: {e}]"
                    print(f"  {error_msg}")
                    return error_msg
            
            # No JSON found - check for common errors in stderr
            if result.returncode != 0:
                error_msg = f"[ERROR: Process exited with code {result.returncode}]\n{result.stderr[:500]}"
                print(f"  {error_msg[:100]}...")
                return error_msg
            
            # No JSON found in output
            error_msg = f"[ERROR: No JSON response found in output]\nstdout: {stdout[:500]}\nstderr: {result.stderr[:500]}"
            print(f"  [ERROR: No JSON response found in output]")
            return error_msg
        except subprocess.TimeoutExpired:
            error_msg = "[ERROR: Request timed out after 300 seconds]"
            print(f"  {error_msg}")
            return error_msg
        except Exception as e:
            error_msg = f"[ERROR: {e}]"
            print(f"  {error_msg}")
            return error_msg


def get_agent(agent_name: str) -> Agent:
    """Factory function to create an agent by name."""
    if agent_name == "ask-forge":
        return AskForgeAgent()
    else:
        available = ", ".join(config.AVAILABLE_AGENTS)
        raise ValueError(f"Unknown agent: {agent_name}. Available: {available}")


def is_error_response(response: str) -> bool:
    """Check if the response is an error message rather than a real response."""
    return response.startswith("[ERROR:")


def verify_fact_with_llm(fact: str, response: str, openrouter_api_key: str) -> bool:
    """
    Use LLM as a judge to verify if a fact is represented in the response.
    Uses OpenRouter API with a configurable model.
    """
    if not response or is_error_response(response):
        return False
    
    prompt = config.LLM_JUDGE_PROMPT.format(fact=fact, response=response)

    try:
        import requests
        resp = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {openrouter_api_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": config.LLM_JUDGE_MODEL,
                "max_tokens": config.LLM_JUDGE_MAX_TOKENS,
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        result = data["choices"][0]["message"]["content"].strip().lower()
        return result == "true"
    except Exception as e:
        print(f"    [LLM Judge Error: {e}]")
        return False


def verify_fact_with_keywords(fact: str, response: str) -> bool:
    """
    Fallback: Check if a fact is represented using keyword matching.
    """
    if not response or is_error_response(response):
        return False
    
    fact_lower = fact.lower()
    response_lower = response.lower()
    
    common_words = {'the', 'is', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had',
                    'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
                    'shall', 'can', 'need', 'dare', 'ought', 'used', 'that', 'this', 'these',
                    'those', 'with', 'from', 'into', 'during', 'before', 'after', 'above',
                    'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
                    'there', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both',
                    'few', 'more', 'most', 'other', 'some', 'such', 'only', 'same', 'than',
                    'very', 'just', 'also', 'and', 'but', 'for', 'nor', 'yet', 'not'}
    
    fact_words = set(re.findall(r'\b\w+\b', fact_lower))
    key_terms = [w for w in fact_words if len(w) > 3 and w not in common_words]
    
    if not key_terms:
        return False
    
    matches = sum(1 for term in key_terms if term in response_lower)
    return matches >= len(key_terms) * 0.5


def verify_facts(facts: list, response: str, openrouter_api_key: str = None) -> list[tuple[str, bool]]:
    """Verify all facts against the response using LLM judge or keyword fallback."""
    results = []
    for fact in facts:
        if openrouter_api_key:
            verified = verify_fact_with_llm(fact, response, openrouter_api_key)
        else:
            verified = verify_fact_with_keywords(fact, response)
        results.append((fact, verified))
    return results


def get_available_agents() -> list[str]:
    """Return list of available agent names."""
    return config.AVAILABLE_AGENTS


def generate_html_report(results: TestResults, output_path: str):
    """Generate an HTML report from test results."""
    
    def stats_row(label: str, stats: dict) -> str:
        accuracy = stats['verified'] / stats['total'] * 100 if stats['total'] > 0 else 0
        pass_rate = stats['passed'] / stats['examples'] * 100 if stats['examples'] > 0 else 0
        return f"""
        <tr>
            <td>{html.escape(label)}</td>
            <td>{stats['examples']}</td>
            <td>{stats['passed']} ({pass_rate:.1f}%)</td>
            <td>{stats['verified']}/{stats['total']} ({accuracy:.1f}%)</td>
        </tr>"""
    
    def category_table(title: str, data: dict) -> str:
        if not data:
            return ""
        rows = "".join(stats_row(k, v) for k, v in sorted(data.items()))
        return f"""
        <h3>{title}</h3>
        <table>
            <thead>
                <tr>
                    <th>Category</th>
                    <th>Examples</th>
                    <th>Passed</th>
                    <th>Facts Verified</th>
                </tr>
            </thead>
            <tbody>
                {rows}
            </tbody>
        </table>"""
    
    examples_html = ""
    for ex in results.examples:
        facts_html = ""
        for fact, verified in ex.verified_facts:
            icon = "✓" if verified else "✗"
            cls = "verified" if verified else "not-verified"
            facts_html += f'<li class="{cls}"><span class="icon">{icon}</span> {html.escape(fact)}</li>'
        
        status_cls = "passed" if ex.passed else "failed"
        examples_html += f"""
        <div class="example {status_cls}">
            <div class="example-header">
                <span class="example-num">Example {ex.index + 1}</span>
                <span class="status-badge {status_cls}">{"PASSED" if ex.passed else "FAILED"}</span>
            </div>
            <div class="metadata">
                <div><strong>Repo:</strong> <a href="{html.escape(ex.repo_url)}" target="_blank">{html.escape(ex.repo_url)}</a></div>
                <div><strong>Commit:</strong> <code>{html.escape(ex.commit[:12])}</code></div>
                <div><strong>Type:</strong> {html.escape(ex.metadata.get('type', 'unknown'))} | 
                     <strong>Difficulty:</strong> {html.escape(ex.metadata.get('difficulty', 'unknown'))} | 
                     <strong>Scope:</strong> {html.escape(ex.metadata.get('scope', 'unknown'))}</div>
            </div>
            <div class="question">
                <strong>Question:</strong>
                <p>{html.escape(ex.question)}</p>
            </div>
            <div class="response{' error' if is_error_response(ex.response) else ''}">
                <strong>Response:</strong>
                <pre class="{'error-response' if is_error_response(ex.response) else ''}">{html.escape(ex.response) if ex.response else '(empty)'}</pre>
            </div>
            <div class="facts">
                <strong>Facts ({sum(1 for _, v in ex.verified_facts if v)}/{len(ex.facts)} verified):</strong>
                <ul>{facts_html}</ul>
            </div>
        </div>"""
    
    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Test Results - {html.escape(results.agent_name)}</title>
    <style>
        * {{ box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }}
        h1 {{ color: #333; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }}
        h2 {{ color: #555; margin-top: 30px; }}
        h3 {{ color: #666; }}
        .summary {{
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }}
        .summary-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
        }}
        .stat-card {{
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
            text-align: center;
        }}
        .stat-value {{
            font-size: 2em;
            font-weight: bold;
            color: #4CAF50;
        }}
        .stat-label {{
            color: #666;
            font-size: 0.9em;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            background: white;
            margin: 10px 0;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        th, td {{
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #eee;
        }}
        th {{ background: #4CAF50; color: white; }}
        tr:hover {{ background: #f5f5f5; }}
        .example {{
            background: white;
            padding: 20px;
            margin: 15px 0;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            border-left: 4px solid #ddd;
        }}
        .example.passed {{ border-left-color: #4CAF50; }}
        .example.failed {{ border-left-color: #f44336; }}
        .example-header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }}
        .example-num {{ font-weight: bold; font-size: 1.1em; }}
        .status-badge {{
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.85em;
            font-weight: bold;
        }}
        .status-badge.passed {{ background: #e8f5e9; color: #2e7d32; }}
        .status-badge.failed {{ background: #ffebee; color: #c62828; }}
        .metadata {{ color: #666; font-size: 0.9em; margin-bottom: 10px; }}
        .metadata div {{ margin: 3px 0; }}
        .question p {{ background: #f8f9fa; padding: 10px; border-radius: 4px; margin: 5px 0; }}
        .response pre {{
            background: #263238;
            color: #aed581;
            padding: 15px;
            border-radius: 4px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
            max-height: 300px;
            overflow-y: auto;
        }}
        .response pre.error-response {{
            background: #4a1a1a;
            color: #ff8a80;
            border: 1px solid #c62828;
        }}
        .facts ul {{ list-style: none; padding: 0; }}
        .facts li {{
            padding: 8px 12px;
            margin: 5px 0;
            border-radius: 4px;
            font-size: 0.9em;
        }}
        .facts li.verified {{ background: #e8f5e9; }}
        .facts li.not-verified {{ background: #ffebee; }}
        .icon {{ margin-right: 8px; }}
        code {{ background: #e8e8e8; padding: 2px 6px; border-radius: 3px; font-family: monospace; }}
        a {{ color: #1976d2; }}
    </style>
</head>
<body>
    <h1>Test Results</h1>
    
    <div class="summary">
        <h2>Summary</h2>
        <p><strong>Agent:</strong> {html.escape(results.agent_name)}</p>
        <p><strong>Timestamp:</strong> {html.escape(results.timestamp)}</p>
        
        <div class="summary-grid">
            <div class="stat-card">
                <div class="stat-value">{results.total_examples}</div>
                <div class="stat-label">Examples Tested</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">{results.passed_examples}</div>
                <div class="stat-label">Passed ({results.passed_examples / results.total_examples * 100:.1f}%)</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">{results.verified_facts}/{results.total_facts}</div>
                <div class="stat-label">Facts Verified</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">{results.accuracy:.1f}%</div>
                <div class="stat-label">Accuracy</div>
            </div>
        </div>
    </div>
    
    <div class="breakdown">
        <h2>Results Breakdown</h2>
        {category_table("By Type", results.results_by_type)}
        {category_table("By Difficulty", results.results_by_difficulty)}
        {category_table("By Scope", results.results_by_scope)}
    </div>
    
    <h2>Detailed Results</h2>
    {examples_html}
</body>
</html>"""
    
    with open(output_path, 'w') as f:
        f.write(html_content)
    
    print(f"\nHTML report saved to: {output_path}")


def save_json_report(results: TestResults, output_dir: str = "reports/runs", run_id: str = None, 
                     status: str = "complete", target_examples: int = None) -> str:
    """Save test results as JSON for review system.
    
    Args:
        results: TestResults object with current results
        output_dir: Directory to save reports
        run_id: Existing run ID (for updates) or None to generate new one
        status: "in_progress" or "complete"
        target_examples: Total number of examples to test (for progress tracking)
    """
    os.makedirs(output_dir, exist_ok=True)
    
    # Create run ID from timestamp and agent name if not provided
    if run_id is None:
        run_id = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{results.agent_name.replace(' ', '-').replace('(', '').replace(')', '')}"
    
    # Build JSON structure
    report = {
        "id": run_id,
        "agent_name": results.agent_name,
        "timestamp": datetime.now().isoformat(),
        "status": status,
        "progress": {
            "completed": results.total_examples,
            "total": target_examples or results.total_examples
        },
        "examples": [
            {
                "index": ex.index,
                "repo_url": ex.repo_url,
                "commit": ex.commit,
                "question": ex.question,
                "response": ex.response,
                "facts": ex.facts,
                "llm_fact_verdicts": [v for _, v in ex.verified_facts],
                "metadata": {
                    "type": ex.metadata.get("type", "unknown"),
                    "difficulty": ex.metadata.get("difficulty", "unknown"),
                    "scope": ex.metadata.get("scope", "unknown"),
                    "is_core_question": ex.metadata.get("is_core_question", False),
                    "includes_code": ex.metadata.get("includes_code", False),
                    "includes_location_hints": ex.metadata.get("includes_location_hints", False),
                }
            }
            for ex in results.examples
        ],
        "summary": {
            "total_examples": results.total_examples,
            "passed_examples": results.passed_examples,
            "total_facts": results.total_facts,
            "llm_verified_facts": results.verified_facts,
            "accuracy": results.accuracy
        },
        "results_by_type": results.results_by_type,
        "results_by_difficulty": results.results_by_difficulty,
        "results_by_scope": results.results_by_scope
    }
    
    # Save to file
    output_path = os.path.join(output_dir, f"{run_id}.json")
    with open(output_path, 'w') as f:
        json.dump(report, f, indent=2)
    
    if status == "complete":
        print(f"\nJSON report saved to: {output_path}")
    
    return run_id


def print_usage():
    available = ", ".join(get_available_agents())
    print(f"Usage: python {sys.argv[0]} [num_examples] [agent] [--html]")
    print(f"  num_examples: Number of examples to test (default: 1)")
    print(f"  agent: Agent to use (default: ask-forge)")
    print(f"  --html: Also generate HTML report (optional)")
    print(f"  Available agents: {available}")
    print()
    print("Examples:")
    print(f"  python {sys.argv[0]} 5 ask-forge")
    print(f"  python {sys.argv[0]} 10 claude")
    print(f"  python {sys.argv[0]} 3 claude-haiku --html")
    print()
    print("Reports are saved to reports/runs/ as JSON")
    print("Use review-server.py to review results in browser")
    print()
    print("Environment variables can be set in .env file")


def main():
    # Parse arguments
    num_examples = 1
    agent_name = "ask-forge"
    generate_html = False
    
    args = sys.argv[1:]
    if "-h" in args or "--help" in args:
        print_usage()
        sys.exit(0)
    
    if "--html" in args:
        generate_html = True
        args.remove("--html")
    
    if len(args) > 0:
        try:
            num_examples = int(args[0])
        except ValueError:
            print(f"Error: Invalid number of examples: {args[0]}")
            print_usage()
            sys.exit(1)
    
    if len(args) > 1:
        agent_name = args[1]
    
    # Create agent
    try:
        agent = get_agent(agent_name)
    except ValueError as e:
        print(f"Error: {e}")
        print_usage()
        sys.exit(1)
    except ImportError as e:
        print(f"Error: {e}")
        sys.exit(1)
    
    # Initialize LLM judge using OpenRouter
    openrouter_api_key = os.environ.get("OPENROUTER_API_KEY")
    if openrouter_api_key:
        print("Using LLM judge for fact verification")
    else:
        print("Using keyword matching for fact verification")
        print("(Set OPENROUTER_API_KEY to use LLM judge)")
    
    # Load the dataset
    print()
    print("Loading dataset from Hugging Face...")
    dataset = load_dataset("Qodo/deep_code_bench", split="train")
    print(f"Loaded {len(dataset)} examples")
    print(f"Agent: {agent.name}")
    print()
    
    # Initialize results
    test_results = TestResults(
        agent_name=agent.name,
        timestamp=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    )
    
    # Generate run ID upfront for progress tracking
    run_id = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{agent.name.replace(' ', '-').replace('(', '').replace(')', '')}"
    target_examples = min(num_examples, len(dataset))
    
    for i in range(target_examples):
        example = dataset[i]
        
        metadata = example['metadata']
        repo_url = metadata['repo'].replace('.git', '')
        commit = metadata['commit']
        question = example['question']
        facts = example['facts']
        
        # Extract all metadata fields
        example_type = metadata.get('type', 'unknown')
        difficulty = metadata.get('difficulty', 'unknown')
        scope = metadata.get('scope', 'unknown')
        is_core_question = metadata.get('is_core_question', False)
        includes_code = metadata.get('includes_code', False)
        includes_location_hints = metadata.get('includes_location_hints', False)
        n_context_files = metadata.get('n_context_files', 0)
        n_context_nodes = metadata.get('n_context_nodes', 0)
        n_files_pr = metadata.get('n_files_pr', 0)
        pr = metadata.get('pr', None)
        
        print(f"Example {i + 1}/{num_examples}")
        print(f"  Repo: {repo_url}")
        print(f"  Commit: {commit[:12]}...")
        print(f"  Type: {example_type} | Difficulty: {difficulty} | Scope: {scope}")
        print(f"  Core: {is_core_question} | Code: {includes_code} | Hints: {includes_location_hints}")
        print(f"  Context: {n_context_files} files, {n_context_nodes} nodes | PR: {pr} ({n_files_pr} files)")
        print(f"  Question: {question[:80]}...")
        print(f"  Facts: {len(facts)}")
        print()
        
        # Get response from agent
        print(f"  Calling {agent.name}...")
        response = agent.ask(repo_url, question, commit)
        
        # Verify facts
        verified_facts = verify_facts(facts, response, openrouter_api_key)
        verified_count = sum(1 for _, v in verified_facts if v)
        passed = verified_count > 0
        
        # Store result
        example_result = ExampleResult(
            index=i,
            repo_url=repo_url,
            commit=commit,
            question=question,
            facts=facts,
            response=response,
            verified_facts=verified_facts,
            metadata=metadata,
            passed=passed
        )
        test_results.examples.append(example_result)
        
        # Track by type, difficulty, scope
        for category, key in [(test_results.results_by_type, example_type), 
                               (test_results.results_by_difficulty, difficulty), 
                               (test_results.results_by_scope, scope)]:
            if key not in category:
                category[key] = {'total': 0, 'verified': 0, 'examples': 0, 'passed': 0}
            category[key]['total'] += len(facts)
            category[key]['verified'] += verified_count
            category[key]['examples'] += 1
            if passed:
                category[key]['passed'] += 1
        
        # Print results
        if not response:
            print("  Response: (empty)")
        else:
            print(f"  Response: {response[:200]}...")
        print()
        
        print(f"  Fact verification: {verified_count}/{len(facts)}")
        for fact, is_verified in verified_facts:
            status = "✓" if is_verified else "✗"
            print(f"    {status} {fact[:60]}...")
        
        print()
        print(f"  Result: {str(passed).lower()}")
        print()
        
        # Save progress after each example
        save_json_report(test_results, run_id=run_id, status="in_progress", target_examples=target_examples)
        
        print("=" * 60)
        print()
    
    # Summary
    print("SUMMARY")
    print(f"  Agent: {test_results.agent_name}")
    print(f"  Examples tested: {test_results.total_examples}")
    print(f"  Total facts: {test_results.total_facts}")
    print(f"  Facts verified: {test_results.verified_facts}")
    print(f"  Accuracy: {test_results.accuracy:.1f}%")
    
    # Results by category
    def print_category_results(title, results):
        if results:
            print()
            print(title)
            for key, stats in sorted(results.items()):
                accuracy = stats['verified'] / stats['total'] * 100 if stats['total'] > 0 else 0
                pass_rate = stats['passed'] / stats['examples'] * 100 if stats['examples'] > 0 else 0
                print(f"  {key}:")
                print(f"    Examples: {stats['examples']} ({stats['passed']} passed, {pass_rate:.1f}%)")
                print(f"    Facts: {stats['verified']}/{stats['total']} ({accuracy:.1f}%)")
    
    print_category_results("RESULTS BY TYPE", test_results.results_by_type)
    print_category_results("RESULTS BY DIFFICULTY", test_results.results_by_difficulty)
    print_category_results("RESULTS BY SCOPE", test_results.results_by_scope)
    
    # Save JSON report (mark as complete)
    save_json_report(test_results, run_id=run_id, status="complete", target_examples=target_examples)
    
    # Generate HTML report (optional)
    if generate_html:
        report_filename = f"test-results-{agent_name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.html"
        generate_html_report(test_results, report_filename)
    
    print(f"\nTo review results, run: python review-server.py")
    print(f"Then open http://localhost:5000 in your browser")


if __name__ == "__main__":
    main()
