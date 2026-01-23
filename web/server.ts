import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ask, connect } from "../index";

const PORT = 3000;
const DATA_DIR = join(import.meta.dir, "data");
const SAMPLES_FILE = join(DATA_DIR, "samples.json");

interface Sample {
	id: string;
	timestamp: string;
	repoUrl: string;
	committish: string;
	question: string;
	response: string;
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
	feedback?: "correct" | "incorrect";
	difficulty?: "easy" | "medium" | "hard";
}

async function loadSamples(): Promise<Sample[]> {
	try {
		const data = await readFile(SAMPLES_FILE, "utf-8");
		return JSON.parse(data);
	} catch {
		return [];
	}
}

async function saveSamples(samples: Sample[]): Promise<void> {
	await mkdir(DATA_DIR, { recursive: true });
	await writeFile(SAMPLES_FILE, JSON.stringify(samples, null, 2));
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ask Forge</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            background: #f5f5f5;
            color: #333;
            padding: 20px;
            max-width: 900px;
            margin: 0 auto;
        }
        h1 { color: #2c3e50; margin-bottom: 20px; }
        .card {
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            padding: 20px;
            margin-bottom: 20px;
        }
        label {
            display: block;
            font-weight: 600;
            margin-bottom: 5px;
            color: #34495e;
        }
        input, textarea {
            width: 100%;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
            margin-bottom: 15px;
        }
        textarea { min-height: 80px; resize: vertical; }
        .btn {
            display: inline-block;
            padding: 10px 20px;
            border-radius: 4px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            font-size: 14px;
            margin-right: 10px;
            margin-bottom: 10px;
        }
        .btn-primary { background: #3498db; color: white; }
        .btn-primary:hover { background: #2980b9; }
        .btn-primary:disabled { background: #95a5a6; cursor: not-allowed; }
        .btn-success { background: #27ae60; color: white; }
        .btn-success:hover { background: #219a52; }
        .btn-success.active { box-shadow: 0 0 0 3px rgba(39, 174, 96, 0.5); }
        .btn-danger { background: #e74c3c; color: white; }
        .btn-danger:hover { background: #c0392b; }
        .btn-danger.active { box-shadow: 0 0 0 3px rgba(231, 76, 60, 0.5); }
        .btn-outline {
            background: white;
            border: 2px solid #3498db;
            color: #3498db;
        }
        .btn-outline:hover { background: #3498db; color: white; }
        .btn-outline.active { background: #3498db; color: white; }
        .response-box {
            background: #263238;
            color: #aed581;
            padding: 15px;
            border-radius: 8px;
            white-space: pre-wrap;
            word-wrap: break-word;
            max-height: 400px;
            overflow-y: auto;
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 13px;
        }
        .hidden { display: none; }
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        .loading::after {
            content: '';
            animation: dots 1.5s infinite;
        }
        @keyframes dots {
            0%, 20% { content: '.'; }
            40% { content: '..'; }
            60%, 100% { content: '...'; }
        }
        .feedback-section, .difficulty-section {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #eee;
        }
        .feedback-section h3, .difficulty-section h3 {
            font-size: 14px;
            margin-bottom: 10px;
            color: #666;
        }
        .tool-calls {
            margin-top: 15px;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 4px;
            font-size: 12px;
        }
        .tool-calls summary {
            cursor: pointer;
            font-weight: 600;
            color: #666;
        }
        .tool-call {
            margin: 8px 0;
            padding: 8px;
            background: white;
            border-radius: 4px;
            border-left: 3px solid #3498db;
        }
        .saved-indicator {
            color: #27ae60;
            font-size: 14px;
            margin-left: 10px;
        }
        .inline-form {
            display: flex;
            gap: 10px;
        }
        .inline-form input:first-child { flex: 2; }
        .inline-form input:last-child { flex: 1; }
    </style>
</head>
<body>
    <h1>Ask Forge</h1>
    
    <div class="card">
        <form id="ask-form">
            <div class="inline-form">
                <div style="flex: 2;">
                    <label for="repo-url">Repository URL</label>
                    <input type="text" id="repo-url" placeholder="https://github.com/owner/repo" required>
                </div>
                <div style="flex: 1;">
                    <label for="committish">Committish (optional)</label>
                    <input type="text" id="committish" placeholder="HEAD, branch, tag, SHA">
                </div>
            </div>
            <label for="question">Question</label>
            <textarea id="question" placeholder="What frameworks does this project use?" required></textarea>
            <button type="submit" class="btn btn-primary" id="submit-btn">Ask</button>
        </form>
    </div>
    
    <div id="loading" class="card hidden">
        <div class="loading">Connecting to repository and analyzing</div>
    </div>
    
    <div id="result" class="card hidden">
        <h2>Response</h2>
        <div class="response-box" id="response-text"></div>
        
        <details class="tool-calls" id="tool-calls-section">
            <summary>Tool Calls (<span id="tool-calls-count">0</span>)</summary>
            <div id="tool-calls-list"></div>
        </details>
        
        <div class="feedback-section">
            <h3>Was this response correct?</h3>
            <button class="btn btn-success" id="feedback-correct" onclick="setFeedback('correct')">Correct</button>
            <button class="btn btn-danger" id="feedback-incorrect" onclick="setFeedback('incorrect')">Incorrect</button>
            <span id="feedback-saved" class="saved-indicator hidden">Saved!</span>
        </div>
        
        <div class="difficulty-section">
            <h3>How difficult was this question?</h3>
            <button class="btn btn-outline" id="diff-easy" onclick="setDifficulty('easy')">Easy</button>
            <button class="btn btn-outline" id="diff-medium" onclick="setDifficulty('medium')">Medium</button>
            <button class="btn btn-outline" id="diff-hard" onclick="setDifficulty('hard')">Hard</button>
            <span id="difficulty-saved" class="saved-indicator hidden">Saved!</span>
        </div>
    </div>

    <script>
    let currentSampleId = null;
    
    document.getElementById('ask-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const repoUrl = document.getElementById('repo-url').value;
        const committish = document.getElementById('committish').value || undefined;
        const question = document.getElementById('question').value;
        
        document.getElementById('loading').classList.remove('hidden');
        document.getElementById('result').classList.add('hidden');
        document.getElementById('submit-btn').disabled = true;
        
        // Reset feedback UI
        resetFeedbackUI();
        
        try {
            const response = await fetch('/api/ask', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repoUrl, committish, question })
            });
            
            const data = await response.json();
            
            if (data.error) {
                document.getElementById('response-text').textContent = 'Error: ' + data.error;
            } else {
                currentSampleId = data.sampleId;
                document.getElementById('response-text').textContent = data.response;
                
                // Show tool calls
                const toolCalls = data.toolCalls || [];
                document.getElementById('tool-calls-count').textContent = toolCalls.length;
                document.getElementById('tool-calls-list').innerHTML = toolCalls.map(tc => 
                    '<div class="tool-call"><strong>' + tc.name + '</strong>: ' + 
                    JSON.stringify(tc.arguments) + '</div>'
                ).join('');
            }
            
            document.getElementById('result').classList.remove('hidden');
        } catch (err) {
            document.getElementById('response-text').textContent = 'Error: ' + err.message;
            document.getElementById('result').classList.remove('hidden');
        } finally {
            document.getElementById('loading').classList.add('hidden');
            document.getElementById('submit-btn').disabled = false;
        }
    });
    
    function resetFeedbackUI() {
        document.getElementById('feedback-correct').classList.remove('active');
        document.getElementById('feedback-incorrect').classList.remove('active');
        document.getElementById('diff-easy').classList.remove('active');
        document.getElementById('diff-medium').classList.remove('active');
        document.getElementById('diff-hard').classList.remove('active');
        document.getElementById('feedback-saved').classList.add('hidden');
        document.getElementById('difficulty-saved').classList.add('hidden');
    }
    
    async function setFeedback(feedback) {
        if (!currentSampleId) return;
        
        document.getElementById('feedback-correct').classList.toggle('active', feedback === 'correct');
        document.getElementById('feedback-incorrect').classList.toggle('active', feedback === 'incorrect');
        
        await fetch('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sampleId: currentSampleId, feedback })
        });
        
        showSaved('feedback-saved');
    }
    
    async function setDifficulty(difficulty) {
        if (!currentSampleId) return;
        
        document.getElementById('diff-easy').classList.toggle('active', difficulty === 'easy');
        document.getElementById('diff-medium').classList.toggle('active', difficulty === 'medium');
        document.getElementById('diff-hard').classList.toggle('active', difficulty === 'hard');
        
        await fetch('/api/difficulty', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sampleId: currentSampleId, difficulty })
        });
        
        showSaved('difficulty-saved');
    }
    
    function showSaved(elementId) {
        const el = document.getElementById(elementId);
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 2000);
    }
    </script>
</body>
</html>`;

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		// Serve HTML
		if (url.pathname === "/" && req.method === "GET") {
			return new Response(HTML, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// API: Ask question
		if (url.pathname === "/api/ask" && req.method === "POST") {
			try {
				const body = (await req.json()) as {
					repoUrl: string;
					committish?: string;
					question: string;
				};

				const { repoUrl, committish, question } = body;

				if (!repoUrl || !question) {
					return Response.json({ error: "Missing repoUrl or question" }, { status: 400 });
				}

				// Connect to repo
				const repo = await connect(repoUrl, { committish });

				// Ask the question
				const result = await ask(repo, question);

				// Create sample
				const sample: Sample = {
					id: crypto.randomUUID(),
					timestamp: new Date().toISOString(),
					repoUrl,
					committish: committish || "HEAD",
					question,
					response: result.response,
					toolCalls: result["tool-calls"],
				};

				// Save sample
				const samples = await loadSamples();
				samples.push(sample);
				await saveSamples(samples);

				return Response.json({
					sampleId: sample.id,
					response: result.response,
					toolCalls: result["tool-calls"],
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return Response.json({ error: message }, { status: 500 });
			}
		}

		// API: Set feedback
		if (url.pathname === "/api/feedback" && req.method === "POST") {
			try {
				const body = (await req.json()) as {
					sampleId: string;
					feedback: "correct" | "incorrect";
				};

				const samples = await loadSamples();
				const sample = samples.find((s) => s.id === body.sampleId);
				if (sample) {
					sample.feedback = body.feedback;
					await saveSamples(samples);
				}

				return Response.json({ success: true });
			} catch (error) {
				return Response.json({ error: "Failed to save feedback" }, { status: 500 });
			}
		}

		// API: Set difficulty
		if (url.pathname === "/api/difficulty" && req.method === "POST") {
			try {
				const body = (await req.json()) as {
					sampleId: string;
					difficulty: "easy" | "medium" | "hard";
				};

				const samples = await loadSamples();
				const sample = samples.find((s) => s.id === body.sampleId);
				if (sample) {
					sample.difficulty = body.difficulty;
					await saveSamples(samples);
				}

				return Response.json({ success: true });
			} catch (error) {
				return Response.json({ error: "Failed to save difficulty" }, { status: 500 });
			}
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`Ask Forge web UI running at http://localhost:${PORT}`);
