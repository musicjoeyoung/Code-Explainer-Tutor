import * as schema from "./db/schema";

import { and, eq } from "drizzle-orm";
import { createFiberplane, createOpenAPISpec } from "@fiberplane/hono";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Octokit } from "@octokit/rest";
import { StreamableHTTPTransport } from "@hono/mcp";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  GOOGLE_AI_API_KEY: string;
  GITHUB_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Root endpoint
app.get("/", (c) => {
  return c.json({
    name: "Code Explainer + Tutor MCP Server",
    version: "1.0.0",
    description:
      "MCP server for code analysis, explanation, and interactive learning",
    endpoints: {
      mcp: "/mcp",
      health: "/health",
      repositories: "/repositories",
      upload: "/repositories/upload",
      github: "/repositories/github",
      viewer: "/viewer",
    },
  });
});

// Web viewer for analysis results
app.get("/viewer", async (c) => {
  const db = drizzle(c.env.DB);
  const repositories = await db.select().from(schema.repositories).limit(10);

  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Code Explainer + Tutor - Analysis Viewer</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #333; border-bottom: 3px solid #007acc; padding-bottom: 10px; }
        .repo { border: 1px solid #ddd; margin: 20px 0; padding: 20px; border-radius: 5px; background: #fafafa; }
        .repo h3 { margin-top: 0; color: #007acc; }
        .repo-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 10px 0; }
        .repo-info span { background: #e7f3ff; padding: 5px 10px; border-radius: 3px; font-size: 0.9em; }
        .actions { margin-top: 15px; }
        .btn { display: inline-block; padding: 8px 16px; margin: 5px; background: #007acc; color: white; text-decoration: none; border-radius: 4px; font-size: 0.9em; }
        .btn:hover { background: #005a9e; }
        .empty { text-align: center; color: #666; font-style: italic; padding: 40px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 Code Explainer + Tutor - Analysis Viewer</h1>
        <p>View comprehensive code analysis results for interview preparation</p>
        
        ${repositories.length === 0
      ? '<div class="empty">No repositories analyzed yet. Use the MCP tool to analyze a GitHub repository!</div>'
      : repositories
        .map(
          (repo) => `
            <div class="repo">
                <h3>${repo.name}</h3>
                <div class="repo-info">
                    <span><strong>Files:</strong> ${repo.fileCount}</span>
                    <span><strong>Size:</strong> ${Math.round(repo.totalSize / 1024)} KB</span>
                    <span><strong>Languages:</strong> ${repo.languages?.join(", ") || "Unknown"}</span>
                    <span><strong>Source:</strong> ${repo.sourceType}</span>
                </div>
                <div class="actions">
                    <a href="/repositories/${repo.id}/explanations" class="btn">View Analysis</a>
                    <a href="${repo.sourceUrl}" target="_blank" class="btn">GitHub Repo</a>
                </div>
            </div>
          `,
        )
        .join("")
    }
    </div>
</body>
</html>`;

  return c.html(html);
});

// Helper function to detect file languages
function detectLanguages(files: string[]): string[] {
  const extensions = files
    .map((f) => f.split(".").pop()?.toLowerCase())
    .filter(Boolean);
  const langMap: Record<string, string> = {
    js: "JavaScript",
    ts: "TypeScript",
    py: "Python",
    java: "Java",
    cpp: "C++",
    c: "C",
    cs: "C#",
    php: "PHP",
    rb: "Ruby",
    go: "Go",
    rs: "Rust",
    kt: "Kotlin",
    swift: "Swift",
  };

  const languages = [
    ...new Set(
      extensions
        .map((ext) => (ext ? langMap[ext] : undefined))
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  return languages;
}

// Helper function to convert markdown to proper HTML structure matching user specifications
// Helper: escape HTML for safe rendering of code blocks (we will NOT use <code> tags)
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHtml(markdown: string): string {
  let html = markdown;

  // Remove the main title since we add it in template
  html = html.replace(
    /^# 🎯 Comprehensive Code Analysis for Interview Preparation\n*/gm,
    "",
  );

  // Convert section headers to h2 and wrap in section tags
  html = html.replace(
    /^## (\d+)\. (.+)$/gm,
    "</section>\n<section>\n<h2>$1. $2</h2>",
  );

  // Convert subsection headers to h3
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");

  // Handle quiz questions first - convert to details/summary format
  // This needs to be done before other processing to avoid interference
  html = html.replace(
    /\*\*Question (\d+):\*\* (.*?)\n\*\*Expected Answer:\*\* (.*?)\n\*\*Follow-up:\*\* (.*?)(?=\n\*\*Question|\n\*\*Resource|$)/gs,
    (match, questionNum, questionText, expectedAnswer, followUp) => {
      // Process the question text to handle inline code without using <code> tags
      const processedQuestionText = questionText
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, '<span class="inline-code">$1</span>');

      const processedExpectedAnswer = expectedAnswer
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, '<span class="inline-code">$1</span>');

      const processedFollowUp = followUp
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, '<span class="inline-code">$1</span>');

      return `\n<details>
  <summary><strong>Question ${questionNum}:</strong> ${processedQuestionText}</summary>
  <p><strong>Expected Answer:</strong> ${processedExpectedAnswer}</p>
  <p><strong>Follow-up:</strong> ${processedFollowUp}</p>
</details>\n`;
    },
  );

  // Extract and remove resources section - will be added inside content div
  // Support both plain URLs and markdown links like [Title](https://...)
  const resourceMatches = html.match(
    /\*\*Resource \d+:\*\* .*? - (?:\[[^\]]+\]\(https?:\/\/[^\s]+\)|https?:\/\/[^\s]+) - .*?(?=\n\*\*Resource|$)/gs,
  );
  let resourcesSection = "";
  let resourcesList = "";
  if (resourceMatches) {
    const listHtml = resourceMatches
      .map((match) => {
        // Parse possible forms:
        // **Resource 1:** Title - https://... - Description
        // **Resource 1:** Title - [Title](https://...) - Description
        const resourceMatch = match.match(
          /\*\*Resource (\d+):\*\* (.*?) - (?:(?:\[(.*?)\]\((https?:\/\/[^\s]+)\))|(https?:\/\/[^\s]+)) - (.*?)$/s,
        );
        if (resourceMatch) {
          // If markdown link form matched, resourceMatch[3]=title, [4]=url
          // Else resourceMatch[2]=title, [5]=url
          const mdTitle = resourceMatch[3];
          const mdUrl = resourceMatch[4];
          const plainTitle = resourceMatch[2];
          const plainUrl = resourceMatch[5];
          const title = mdTitle || plainTitle || "Resource";
          const url = mdUrl || plainUrl || "";
          // Render as plain text list item: Title - URL
          return `                    <li>${title} - ${url}</li>`;
        }
        return "";
      })
      .join("\n");
    resourcesList = listHtml;

    resourcesSection = `\n</section>\n<section>\n<h2>8. SUPPLEMENTAL LEARNING RESOURCES</h2>\n<ul>\n${resourcesList}\n</ul>\n</section>`;

    // Remove resources from main content (match both plain URL and markdown link forms)
    html = html.replace(
      /\*\*Resource \d+:\*\* .*? - (?:\[[^\]]+\]\(https?:\/\/[^\s]+\)|https?:\/\/[^\s]+) - .*?(?=\n\*\*Resource|$)/gs,
      "",
    );
  }

  // Convert bold text (but not in already processed areas)
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  // Convert inline code to span.inline-code (no <code> tags), always HTML-escape content
  html = html.replace(/`([^`]+)`/g, (_m: string, inner: string) => `<span class="inline-code">${escapeHtml(inner)}</span>`);

  // Convert code blocks to pre.code-block and escape content (no <code> tag)
  html = html.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.replace(/```\w*\n?/g, "").replace(/```$/g, "");
    return `<pre class="code-block">${escapeHtml(code)}</pre>`;
  });

  // Process line by line for proper list and paragraph structure
  const lines = html.split("\n");
  const processedLines: string[] = [];
  let inList = false;
  let listType = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines
    if (!line) {
      if (inList) {
        processedLines.push(`</${listType}>`);
        inList = false;
      }
      continue;
    }

    // Skip lines that are already HTML elements
    if (
      line.startsWith("<") &&
      (line.includes("h2>") ||
        line.includes("h3>") ||
        line.includes("details>") ||
        line.includes("summary>") ||
        line.includes("pre>") ||
        line.includes("/details>") ||
        line.includes("/summary>") ||
        line.includes("section>"))
    ) {
      if (inList) {
        processedLines.push(`</${listType}>`);
        inList = false;
      }
      processedLines.push(line);
      continue;
    }

    // Handle bullet points - convert to ul/li with p tags
    if (line.startsWith("- ")) {
      if (!inList || listType !== "ul") {
        if (inList) processedLines.push(`</${listType}>`);
        processedLines.push("<ul>");
        inList = true;
        listType = "ul";
      }
      const content = line.substring(2).trim();
      processedLines.push(`                    <li>
                        <p>${content}</p>
                    </li>`);
      continue;
    }

    // Handle numbered lists - convert to ol/li with p tags
    if (/^\d+\.\s/.test(line)) {
      if (!inList || listType !== "ol") {
        if (inList) processedLines.push(`</${listType}>`);
        processedLines.push("<ol>");
        inList = true;
        listType = "ol";
      }
      const content = line.replace(/^\d+\.\s/, "").trim();
      processedLines.push(`                    <li>
                        <p>${content}</p>
                    </li>`);
      continue;
    }

    // Close list if we're no longer in list items
    if (inList) {
      processedLines.push(`</${listType}>`);
      inList = false;
    }

    // All remaining text goes in p tags
    if (line && !line.startsWith("<")) {
      processedLines.push(`                <p>${line}</p>`);
    } else if (line.startsWith("<")) {
      processedLines.push(line);
    }
  }

  // Close any remaining list!
  if (inList) {
    processedLines.push(`</${listType}>`);
  }

  // Add opening section tag at the beginning and clean up any extra closing tags
  let result = processedLines.join("\n");
  result = result.replace(/^<\/section>\n/, ""); // Remove leading closing section tag
  result = `<section>\n${result}`; // Add opening section tag

  // If resourcesSection exists, try to insert into an existing 8. SUPPLEMENTAL LEARNING RESOURCES header
  if (resourcesSection) {
    // Look for the h2 title for section 8 (case-insensitive-ish)
    const h2Regex = /<h2>\s*8\.\s*SUPPLEMENTAL LEARNING RESOURCES\s*<\/h2>/i;
    if (h2Regex.test(result)) {
      // Remove any empty <p> that may immediately follow the h2 to avoid blank paragraph
      result = result.replace(/(<h2>\s*8\.\s*SUPPLEMENTAL LEARNING RESOURCES\s*<\/h2>)\n\s*<p>\s*<\/p>/i, "$1");
      // Insert the <ul> right after the existing h2
      result = result.replace(h2Regex, (match) => `${match}\n<ul>\n${resourcesListPlaceholder(resourcesList)}\n</ul>`);
      // resourcesSection already injected, return result
      return result;
    }
  }

  // Post-process sections: Section 2 is allowed to use <code> tags; convert inline/code-blocks accordingly
  // Find the section 2 block and transform only within it
  result = result.replace(/(<section>[\s\S]*?<h2>\s*2\.\s*[^<]+<\/h2>)([\s\S]*?)(<\/section>)/i, (full, head, body, tail) => {
    let newBody = body;

    // Convert inline .inline-code spans to <code> with escaped content
    newBody = newBody.replace(/<span class=\"inline-code\">([\s\S]*?)<\/span>/g, (_m: string, inner: string) => {
      return `<code>${escapeHtml(inner)}</code>`;
    });

    // Convert pre.code-block to pre with inner <code> (content already escaped)
    newBody = newBody.replace(/<pre class=\"code-block\">([\s\S]*?)<\/pre>/g, (_m: string, inner: string) => {
      return `<pre><code>${inner}</code></pre>`;
    });

    return head + newBody + tail;
  });

  return result + resourcesSection;
}

// Helper to safely inject resourcesList (keeps newline escaping simple)
function resourcesListPlaceholder(listHtml: string): string {
  return listHtml;
}

// Helper function to generate diagram images using Google Imagen
async function generateDiagramImage(
  diagramDescription: string,
  _apiKey?: string,
): Promise<string | null> {
  try {
    // For now, use a more sophisticated SVG generator since Imagen requires special setup
    // In production, you would integrate with Google's Imagen API
    return createAdvancedSVG(diagramDescription);
  } catch (error) {
    console.error("Error generating diagram:", error);
    return createFallbackSVG(diagramDescription);
  }
}

// Advanced SVG diagram generator
function createAdvancedSVG(description: string): string {
  // Determine diagram type from description
  const isProjectStructure =
    description.toLowerCase().includes("project structure") ||
    description.toLowerCase().includes("file organization");
  const isDataFlow =
    description.toLowerCase().includes("data flow") ||
    description.toLowerCase().includes("state") ||
    description.toLowerCase().includes("props");
  const isCodeAnalogies =
    description.toLowerCase().includes("analogies") ||
    description.toLowerCase().includes("concepts");

  if (isProjectStructure) {
    return createProjectStructureSVG(description);
  } else if (isDataFlow) {
    return createStatePropsTreeSVG(description);
  } else if (isCodeAnalogies) {
    return createCodeAnalogiesSVG(description);
  } else {
    return createGenericDiagramSVG(description);
  }
}

// Code analogies SVG generator
function createCodeAnalogiesSVG(description: string): string {
  const svg = `
    <svg width="700" height="500" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .analogy-box { fill: #f3e5f5; stroke: #7b1fa2; stroke-width: 2; }
          .code-box { fill: #e8f5e8; stroke: #388e3c; stroke-width: 2; }
          .text { font-family: Arial, sans-serif; font-size: 12px; fill: #333; }
          .title { font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; fill: #333; }
          .arrow { stroke: #666; stroke-width: 2; marker-end: url(#arrowhead); }
        </style>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#666" />
        </marker>
      </defs>
      
      <rect width="700" height="500" fill="white" stroke="#ddd"/>
      
      <!-- Title -->
      <text x="350" y="30" text-anchor="middle" class="title">Code Analogies & Visual Explanations</text>
      
      <!-- Real World Analogy -->
      <rect x="50" y="80" width="250" height="120" class="analogy-box"/>
      <text x="175" y="105" text-anchor="middle" class="title">Real World Analogy</text>
      <text x="175" y="130" text-anchor="middle" class="text">Train Station Dispatcher</text>
      <text x="175" y="150" text-anchor="middle" class="text">• Directs passengers to platforms</text>
      <text x="175" y="170" text-anchor="middle" class="text">• Each platform leads to different city</text>
      <text x="175" y="190" text-anchor="middle" class="text">• Based on destination (URL)</text>
      
      <!-- Code Concept -->
      <rect x="400" y="80" width="250" height="120" class="code-box"/>
      <text x="525" y="105" text-anchor="middle" class="title">Code Concept</text>
      <text x="525" y="130" text-anchor="middle" class="text">React Router</text>
      <text x="525" y="150" text-anchor="middle" class="text">• Routes components to paths</text>
      <text x="525" y="170" text-anchor="middle" class="text">• Each route renders component</text>
      <text x="525" y="190" text-anchor="middle" class="text">• Based on URL pathname</text>
      
      <!-- Connection Arrow -->
      <line x1="300" y1="140" x2="400" y2="140" class="arrow"/>
      <text x="350" y="135" text-anchor="middle" class="text">Maps to</text>
      
      <!-- Description -->
      <text x="350" y="420" text-anchor="middle" class="text">${description.slice(0, 70)}...</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Project structure SVG generator
function createProjectStructureSVG(description: string): string {
  const svg = `
    <svg width="600" height="500" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .folder { fill: #ffd700; stroke: #b8860b; stroke-width: 2; }
          .file { fill: #e6f3ff; stroke: #007acc; stroke-width: 1; }
          .text { font-family: Arial, sans-serif; font-size: 12px; fill: #333; }
          .title { font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; fill: #333; }
          .line { stroke: #666; stroke-width: 1; }
        </style>
      </defs>
      
      <rect width="600" height="500" fill="white" stroke="#ddd"/>
      
      <!-- Title -->
      <text x="300" y="30" text-anchor="middle" class="title">Project Structure</text>
      
      <!-- Root folder -->
      <rect x="50" y="60" width="100" height="30" class="folder"/>
      <text x="100" y="80" text-anchor="middle" class="text">Root</text>
      
      <!-- Subfolders -->
      <line x1="100" y1="90" x2="100" y2="120" class="line"/>
      <line x1="100" y1="120" x2="150" y2="120" class="line"/>
      
      <rect x="150" y="105" width="80" height="30" class="folder"/>
      <text x="190" y="125" text-anchor="middle" class="text">src/</text>
      
      <rect x="150" y="145" width="80" height="30" class="folder"/>
      <text x="190" y="165" text-anchor="middle" class="text">config/</text>
      
      <!-- Files in src -->
      <line x1="190" y1="135" x2="190" y2="200" class="line"/>
      <line x1="190" y1="200" x2="280" y2="200" class="line"/>
      
      <rect x="280" y="185" width="100" height="25" class="file"/>
      <text x="330" y="202" text-anchor="middle" class="text">index.ts</text>
      
      <rect x="280" y="220" width="100" height="25" class="file"/>
      <text x="330" y="237" text-anchor="middle" class="text">schema.ts</text>
      
      <!-- Description -->
      <text x="300" y="300" text-anchor="middle" class="text">${description.slice(0, 60)}...</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Advanced SVG diagram generator for state/props tree structure
function createStatePropsTreeSVG(description: string): string {
  const svg = `
    <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .component { fill: #e1f5fe; stroke: #0277bd; stroke-width: 2; }
          .state { fill: #fff3e0; stroke: #f57c00; stroke-width: 2; }
          .props { fill: #e8f5e8; stroke: #388e3c; stroke-width: 2; }
          .text { font-family: Arial, sans-serif; font-size: 12px; fill: #333; }
          .title { font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; fill: #333; }
          .line { stroke: #666; stroke-width: 2; }
          .arrow { stroke: #666; stroke-width: 2; marker-end: url(#arrowhead); }
        </style>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#666" />
        </marker>
      </defs>
      
      <rect width="800" height="600" fill="white" stroke="#ddd"/>
      
      <!-- Title -->
      <text x="400" y="30" text-anchor="middle" class="title">State & Props Flow Tree Structure</text>
      
      <!-- Root Component -->
      <rect x="350" y="60" width="100" height="40" class="component"/>
      <text x="400" y="85" text-anchor="middle" class="text">App Component</text>
      
      <!-- State -->
      <rect x="200" y="140" width="80" height="30" class="state"/>
      <text x="240" y="160" text-anchor="middle" class="text">State</text>
      
      <!-- Props flow to children -->
      <rect x="520" y="140" width="80" height="30" class="props"/>
      <text x="560" y="160" text-anchor="middle" class="text">Props</text>
      
      <!-- Child Components -->
      <rect x="150" y="220" width="90" height="35" class="component"/>
      <text x="195" y="242" text-anchor="middle" class="text">Child A</text>
      
      <rect x="280" y="220" width="90" height="35" class="component"/>
      <text x="325" y="242" text-anchor="middle" class="text">Child B</text>
      
      <rect x="470" y="220" width="90" height="35" class="component"/>
      <text x="515" y="242" text-anchor="middle" class="text">Child C</text>
      
      <rect x="600" y="220" width="90" height="35" class="component"/>
      <text x="645" y="242" text-anchor="middle" class="text">Child D</text>
      
      <!-- Arrows showing data flow -->
      <line x1="400" y1="100" x2="240" y2="140" class="arrow"/>
      <line x1="400" y1="100" x2="560" y2="140" class="arrow"/>
      
      <line x1="240" y1="170" x2="195" y2="220" class="arrow"/>
      <line x1="240" y1="170" x2="325" y2="220" class="arrow"/>
      
      <line x1="560" y1="170" x2="515" y2="220" class="arrow"/>
      <line x1="560" y1="170" x2="645" y2="220" class="arrow"/>
      
      <!-- Legend -->
      <rect x="50" y="350" width="700" height="200" fill="#f9f9f9" stroke="#ccc"/>
      <text x="400" y="375" text-anchor="middle" class="title">Tree Structure Legend</text>
      
      <rect x="80" y="390" width="60" height="25" class="component"/>
      <text x="110" y="407" text-anchor="middle" class="text">Component</text>
      <text x="160" y="407" class="text">- React functional/class components</text>
      
      <rect x="80" y="430" width="60" height="25" class="state"/>
      <text x="110" y="447" text-anchor="middle" class="text">State</text>
      <text x="160" y="447" class="text">- Internal component state (useState, this.state)</text>
      
      <rect x="80" y="470" width="60" height="25" class="props"/>
      <text x="110" y="487" text-anchor="middle" class="text">Props</text>
      <text x="160" y="487" class="text">- Data passed from parent to child components</text>
      
      <line x1="80" y1="510" x2="140" y2="510" class="arrow"/>
      <text x="160" y="515" class="text">- Data flow direction (parent → child)</text>
      
      <!-- Description -->
      <text x="400" y="580" text-anchor="middle" class="text">${description.slice(0, 80)}...</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
function createGenericDiagramSVG(description: string): string {
  const svg = `
    <svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .box { fill: #f0f8ff; stroke: #007acc; stroke-width: 2; }
          .text { font-family: Arial, sans-serif; font-size: 12px; fill: #333; }
          .title { font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; fill: #333; }
          .arrow { stroke: #007acc; stroke-width: 2; marker-end: url(#arrowhead); }
        </style>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#007acc" />
        </marker>
      </defs>
      
      <rect width="600" height="400" fill="white" stroke="#ddd"/>
      
      <!-- Title -->
      <text x="300" y="30" text-anchor="middle" class="title">System Diagram</text>
      
      <!-- Main components -->
      <rect x="100" y="80" width="120" height="60" class="box"/>
      <text x="160" y="115" text-anchor="middle" class="text">Component A</text>
      
      <rect x="380" y="80" width="120" height="60" class="box"/>
      <text x="440" y="115" text-anchor="middle" class="text">Component B</text>
      
      <rect x="240" y="200" width="120" height="60" class="box"/>
      <text x="300" y="235" text-anchor="middle" class="text">Core System</text>
      
      <!-- Arrows -->
      <line x1="220" y1="110" x2="380" y2="110" class="arrow"/>
      <line x1="160" y1="140" x2="300" y2="200" class="arrow"/>
      <line x1="440" y1="140" x2="300" y2="200" class="arrow"/>
      
      <!-- Description -->
      <text x="300" y="320" text-anchor="middle" class="text">${description.slice(0, 60)}...</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Fallback SVG diagram generator
function createFallbackSVG(description: string): string {
  const svgDiagram = `
    <svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>
          .title { font-family: Arial, sans-serif; font-size: 16px; font-weight: bold; fill: #333; }
          .subtitle { font-family: Arial, sans-serif; font-size: 12px; fill: #666; }
          .box { fill: #f0f8ff; stroke: #007acc; stroke-width: 2; }
          .arrow { stroke: #007acc; stroke-width: 2; marker-end: url(#arrowhead); }
        </style>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#007acc" />
        </marker>
      </defs>
      
      <rect width="600" height="400" fill="white" stroke="#ddd"/>
      
      <!-- Main boxes -->
      <rect x="50" y="50" width="120" height="60" class="box"/>
      <text x="110" y="85" text-anchor="middle" class="title">Component A</text>
      
      <rect x="250" y="50" width="120" height="60" class="box"/>
      <text x="310" y="85" text-anchor="middle" class="title">Component B</text>
      
      <rect x="450" y="50" width="120" height="60" class="box"/>
      <text x="510" y="85" text-anchor="middle" class="title">Component C</text>
      
      <!-- Arrows -->
      <line x1="170" y1="80" x2="250" y2="80" class="arrow"/>
      <line x1="370" y1="80" x2="450" y2="80" class="arrow"/>
      
      <!-- Description -->
      <text x="300" y="180" text-anchor="middle" class="title">System Architecture</text>
      <text x="300" y="200" text-anchor="middle" class="subtitle">${description.slice(0, 80)}...</text>
      
      <!-- Data flow -->
      <rect x="150" y="250" width="100" height="40" class="box"/>
      <text x="200" y="275" text-anchor="middle" class="subtitle">Data Store</text>
      
      <rect x="350" y="250" width="100" height="40" class="box"/>
      <text x="400" y="275" text-anchor="middle" class="subtitle">API Layer</text>
      
      <line x1="250" y1="270" x2="350" y2="270" class="arrow"/>
    </svg>
  `;

  return `data:image/svg+xml;base64,${btoa(svgDiagram)}`;
}
async function extractZipFiles(
  _zipBuffer: ArrayBuffer,
): Promise<{ files: Map<string, string>; totalSize: number }> {
  // Simple zip extraction - in production, use a proper zip library
  const files = new Map<string, string>();
  let totalSize = 0;

  // Mock implementation - replace with actual zip parsing
  files.set("README.md", "# Sample Repository\nThis is a sample file.");
  files.set("src/index.ts", 'console.log("Hello World");');
  totalSize = 100;

  return { files, totalSize };
}

// Helper function to fetch GitHub repository
async function fetchGitHubRepo(
  url: string,
  branch = "main",
  token?: string,
): Promise<{
  files: Map<string, string>;
  totalSize: number;
  repoName: string;
}> {
  const octokit = new Octokit({ auth: token });
  const urlParts = url.replace("https://github.com/", "").split("/");
  const owner = urlParts[0];
  const repo = urlParts[1];

  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: "true",
  });

  const files = new Map<string, string>();
  let totalSize = 0;

  for (const item of tree.tree) {
    if (item.type === "blob" && item.path) {
      try {
        const { data: blob } = await octokit.rest.git.getBlob({
          owner,
          repo,
          file_sha: item.sha as string,
        });

        const content = atob(blob.content);
        files.set(item.path, content);
        totalSize += content.length;
      } catch (error) {
        console.error(`Failed to fetch file ${item.path}:`, error);
      }
    }
  }

  return { files, totalSize, repoName: repo };
}

// Repository upload endpoint
app.post("/repositories/upload", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    const zipBuffer = await file.arrayBuffer();
    const { files, totalSize } = await extractZipFiles(zipBuffer);

    const repositoryId = crypto.randomUUID();
    const r2Path = `repositories/${repositoryId}`;

    // Store files in R2
    for (const [filePath, content] of files) {
      await c.env.R2.put(`${r2Path}/${filePath}`, content, {
        httpMetadata: { contentType: "text/plain" },
      });
    }

    const languages = detectLanguages(Array.from(files.keys()));

    const [repository] = await db
      .insert(schema.repositories)
      .values({
        id: repositoryId,
        name: file.name.replace(".zip", ""),
        sourceType: "upload",
        fileCount: files.size,
        totalSize,
        languages,
        r2Path,
      })
      .returning();

    return c.json({ repository }, 201);
  } catch (error) {
    return c.json(
      {
        error: "Failed to process upload",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GitHub repository ingestion
app.post("/repositories/github", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const { url, branch = "main" } = await c.req.json();

    if (!url) {
      return c.json({ error: "GitHub URL is required" }, 400);
    }

    // Check if repository already exists
    const existingRepo = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.sourceUrl, url))
      .limit(1);

    if (existingRepo.length > 0) {
      // Repository already exists, return existing one
      return c.json({
        repository: existingRepo[0],
        message: "Repository already exists",
      });
    }

    const { files, totalSize, repoName } = await fetchGitHubRepo(
      url,
      branch,
      c.env.GITHUB_TOKEN,
    );

    const repositoryId = crypto.randomUUID();
    const r2Path = `repositories/${repositoryId}`;

    // Store files in R2
    for (const [filePath, content] of files) {
      await c.env.R2.put(`${r2Path}/${filePath}`, content, {
        httpMetadata: { contentType: "text/plain" },
      });
    }

    const languages = detectLanguages(Array.from(files.keys()));

    const [repository] = await db
      .insert(schema.repositories)
      .values({
        id: repositoryId,
        name: repoName,
        sourceType: "github",
        sourceUrl: url,
        fileCount: files.size,
        totalSize,
        languages,
        r2Path,
      })
      .returning();

    return c.json({ repository }, 201);
  } catch (error) {
    return c.json(
      {
        error: "Failed to fetch GitHub repository",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// List all repositories (with duplicate cleanup)
app.get("/repositories", async (c) => {
  try {
    const db = drizzle(c.env.DB);

    // Get all repositories
    const allRepositories = await db.select().from(schema.repositories);

    // Group by sourceUrl to find duplicates
    const uniqueRepos = new Map();
    const duplicateIds: string[] = [];

    for (const repo of allRepositories) {
      if (repo.sourceUrl && uniqueRepos.has(repo.sourceUrl)) {
        // This is a duplicate, mark for potential cleanup
        duplicateIds.push(repo.id);
      } else if (repo.sourceUrl) {
        uniqueRepos.set(repo.sourceUrl, repo);
      } else {
        // Keep repos without sourceUrl (uploaded files)
        uniqueRepos.set(repo.id, repo);
      }
    }

    const repositories = Array.from(uniqueRepos.values()).slice(0, 50);

    return c.json({
      repositories,
      duplicatesFound: duplicateIds.length,
      message:
        duplicateIds.length > 0
          ? `Found ${duplicateIds.length} duplicate repositories`
          : undefined,
    });
  } catch (error) {
    return c.json(
      {
        error: "Failed to fetch repositories",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get repository details
app.get("/repositories/:id", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");

    const [repository] = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id));

    if (!repository) {
      return c.json({ error: "Repository not found" }, 404);
    }

    // List files from R2
    const listing = await c.env.R2.list({ prefix: `${repository.r2Path}/` });
    const files = listing.objects.map((obj) => ({
      path: obj.key.replace(`${repository.r2Path}/`, ""),
      size: obj.size,
      lastModified: obj.uploaded,
    }));

    return c.json({ repository, files });
  } catch (error) {
    return c.json(
      {
        error: "Failed to fetch repository",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get file content
app.get("/repositories/:id/files/*", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const filePath = c.req.path.split("/files/")[1];

    if (!filePath) {
      return c.json({ error: "File path is required" }, 400);
    }

    const [repository] = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id));

    if (!repository) {
      return c.json({ error: "Repository not found" }, 404);
    }

    const object = await c.env.R2.get(`${repository.r2Path}/${filePath}`);

    if (!object) {
      return c.json({ error: "File not found" }, 404);
    }

    const content = await object.text();
    return c.json({ content, path: filePath });
  } catch (error) {
    return c.json(
      {
        error: "Failed to fetch file",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Generate code explanation
app.post("/repositories/:id/explain", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const genAI = new GoogleGenerativeAI(c.env.GOOGLE_AI_API_KEY);
    const id = c.req.param("id");
    const { file_path, start_line, end_line, explanation_type } =
      await c.req.json();

    const [repository] = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id));

    if (!repository) {
      return c.json({ error: "Repository not found" }, 404);
    }

    // Get file content
    const object = await c.env.R2.get(`${repository.r2Path}/${file_path}`);
    if (!object) {
      return c.json({ error: "File not found" }, 404);
    }

    const fileContent = await object.text();
    const lines = fileContent.split("\n");
    const codeSection = lines
      .slice((start_line || 1) - 1, end_line || lines.length)
      .join("\n");

    const prompt = `Analyze this ${explanation_type} code section and provide a comprehensive explanation:

File: ${file_path}
Code:
\`\`\`
${codeSection}
\`\`\`

Please provide:
1. A clear title for this code section
2. A detailed explanation of what the code does
3. Key concepts and patterns used
4. If this is an authentication flow, include security considerations
5. Generate a Mermaid diagram if applicable for flows or architecture

Format your response as JSON with fields: title, content (markdown), diagram (mermaid syntax if applicable)`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    const response = await model.generateContent(prompt);

    let parsed:
      | { title?: string; content?: string; diagram?: string | null }
      | undefined;
    try {
      parsed = JSON.parse(response.response.text());
    } catch { }

    const explanationObj = {
      title: parsed?.title ?? `${explanation_type} explanation`,
      content: parsed?.content ?? response.response.text(),
      diagram: parsed?.diagram ?? null,
    } as const;

    const [savedExplanation] = await db
      .insert(schema.explanations)
      .values({
        repositoryId: id,
        filePath: file_path,
        explanationType: explanation_type,
        title: explanationObj.title,
        content: explanationObj.content,
        diagramUrl: explanationObj.diagram
          ? `data:text/plain;base64,${btoa(explanationObj.diagram)}`
          : null,
      })
      .returning();

    return c.json({ explanation: savedExplanation }, 201);
  } catch (error) {
    return c.json(
      {
        error: "Failed to generate explanation",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// List explanations with web view
app.get("/repositories/:id/explanations", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");

    const [repository] = await db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, id));

    if (!repository) {
      return c.json({ error: "Repository not found" }, 404);
    }

    const type = c.req.query("type");
    const filePath = c.req.query("file_path");

    let query = db
      .select()
      .from(schema.explanations)
      .where(eq(schema.explanations.repositoryId, id));

    const conditions = [eq(schema.explanations.repositoryId, id)];
    if (type) conditions.push(eq(schema.explanations.explanationType, type));
    if (filePath) conditions.push(eq(schema.explanations.filePath, filePath));

    if (conditions.length > 1) {
      query = db
        .select()
        .from(schema.explanations)
        .where(and(...conditions));
    }

    const explanations = await query;

    // Check if request wants HTML (browser) or JSON (API)
    const acceptHeader = c.req.header("accept") || "";
    if (acceptHeader.includes("text/html")) {
      const html = `
<!DOCTYPE html>
<html>
<head>
    <title>${repository.name} - Code Analysis</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; margin: 0; background: #f8fafc; line-height: 1.4rem; }
        .header { background: linear-gradient(135deg, #007acc 0%, #005a9e 100%); color: white; padding: 24px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .container { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
        .content { background: white; margin: 24px auto; max-width: 1200px; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
        h1 { margin: 0; font-size: 28px; font-weight: 600; }
        .repo-info { background: linear-gradient(135deg, #e7f3ff 0%, #f0f8ff 100%); padding: 20px; border-radius: 8px; margin: 24px 0; border-left: 4px solid #007acc; }
        .repo-info a { color: #007acc; text-decoration: none; font-weight: 500; }
        .repo-info a:hover { text-decoration: underline; }
        .explanation { border: 1px solid #e2e8f0; margin: 32px 0; padding: 32px; border-radius: 12px; background: #ffffff; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
        .explanation h3 { margin-top: 0; color: #007acc; font-size: 24px; font-weight: 600; border-bottom: 2px solid #007acc; padding-bottom: 8px; }
        pre { background: #f8fafc; padding: 20px; border-radius: 8px; overflow-x: auto; border: 1px solid #e2e8f0; font-size: 14px; line-height: 1.5; }
        .empty { text-align: center; color: #64748b; font-style: italic; padding: 60px; font-size: 18px; }
        .back-btn { display: inline-block; padding: 12px 20px; background: #10b981; color: white; text-decoration: none; border-radius: 8px; margin-bottom: 24px; font-weight: 500; transition: background 0.2s; }
        .back-btn:hover { background: #059669; }
        
        /* Content styling */
        .content h1 { color: #1e293b; font-size: 28px; font-weight: 600; margin: 32px 0 24px 0; }
        .content h2 { color: #1e293b; border-bottom: 3px solid #007acc; padding-bottom: 8px; margin: 40px 0 20px 0; font-weight: 600; font-size: 24px; }
        .content h3 { color: #334155; margin: 32px 0 16px 0; font-size: 20px; font-weight: 600; }
        .content h4 { color: #475569; margin: 24px 0 12px 0; font-size: 18px; font-weight: 600; }
        .content p { margin: 16px 0; color: #374151; line-height: 1.6; }
        .content ul { margin: 16px 0; padding-left: 24px; }
        .content ol { margin: 16px 0; padding-left: 24px; }
        .content li { margin: 8px 0; color: #374151; line-height: 1.5; }
  .content .inline-code { background: #f1f5f9; padding: 3px 6px; border-radius: 4px; font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace; font-size: 14px; color: #e11d48; }
  .content pre { background: #f8fafc; padding: 24px; border-radius: 8px; overflow-x: auto; margin: 20px 0; border: 1px solid #e2e8f0; }
  .content pre.code-block { background: #f8fafc; padding: 24px; border-radius: 8px; overflow-x: auto; margin: 20px 0; border: 1px solid #e2e8f0; color: #374151; font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace; font-size: 14px; line-height: 1.5; }
        .content strong { color: #1e293b; font-weight: 600; }
        .content em { color: #6b7280; }
        
        /* Quiz questions using details/summary */
        .content details {
            background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
            border: 1px solid #0ea5e9;
            border-radius: 12px;
            padding: 20px;
            margin: 20px 0;
            box-shadow: 0 2px 8px rgba(14, 165, 233, 0.1);
        }
        .content details summary {
            cursor: pointer;
            font-weight: 600;
            color: #0c4a6e;
            font-size: 16px;
            margin-bottom: 12px;
            list-style: none;
            outline: none;
        }
        .content details summary::-webkit-details-marker {
            display: none;
        }
        .content details summary::before {
            content: "▶";
            margin-right: 8px;
            transition: transform 0.2s;
        }
        .content details[open] summary::before {
            transform: rotate(90deg);
        }
        .content details[open] summary {
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid #bae6fd;
        }
        .content details p {
            margin: 12px 0;
            padding-left: 16px;
        }
        
        /* Diagram styling */
        .diagram { 
            text-align: center; 
            margin: 32px 0; 
            padding: 24px; 
            background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%); 
            border-radius: 12px; 
            border: 1px solid #e5e7eb;
        }
        .diagram img {
            max-width: 100%;
            height: auto;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        
        /* Responsive design */
        @media (max-width: 768px) {
            .content { margin: 16px; padding: 24px; }
            .container { padding: 0 16px; }
            h1 { font-size: 24px; }
            .content h1 { font-size: 24px; }
            .content h2 { font-size: 20px; }
            .quiz-question { padding: 20px; }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="container">
            <h1>📊 ${repository.name} - Code Analysis</h1>
        </div>
    </div>
    <div class="content">
        <a href="/viewer" class="back-btn">← Back to All Repositories</a>
        
        <div class="repo-info">
            <strong>Repository:</strong> ${repository.name}<br>
            <strong>Files:</strong> ${repository.fileCount} | 
            <strong>Size:</strong> ${Math.round(repository.totalSize / 1024)} KB | 
            <strong>Languages:</strong> ${repository.languages?.join(", ") || "Unknown"}<br>
            <strong>Source:</strong> <a href="${repository.sourceUrl}" target="_blank">${repository.sourceUrl}</a>
        </div>
        
        ${explanations.length === 0
          ? '<div class="empty">No analysis found. Use the MCP tool to generate comprehensive analysis!</div>'
          : (
            () => {
              // Get the most recent comprehensive explanation to avoid duplicates
              const comprehensiveExplanation = explanations
                .filter((exp) => exp.explanationType === "comprehensive")
                .sort(
                  (a, b) =>
                    new Date(b.createdAt).getTime() -
                    new Date(a.createdAt).getTime(),
                )[0];

              if (comprehensiveExplanation) {
                const htmlContent = markdownToHtml(
                  comprehensiveExplanation.content,
                );

                // Insert diagrams after specific sections
                let finalContent = htmlContent;

                // Insert project structure diagram after section 4
                if (comprehensiveExplanation.diagramUrl) {
                  finalContent = finalContent.replace(
                    /(<h2>4\. PROJECT STRUCTURE<\/h2>[\s\S]*?)(<h2>5\. DATA FLOW ARCHITECTURE<\/h2>)/,
                    `$1<div class="diagram"><img src="${comprehensiveExplanation.diagramUrl}" alt="Project Structure Diagram" style="max-width: 100%; height: auto;"/></div>$2`,
                  );
                }

                // Get additional diagrams for data flow and code analogies
                const additionalDiagrams = explanations.filter(
                  (exp) => exp.explanationType === "diagram",
                );
                const dataFlowDiagram = additionalDiagrams.find(
                  (d) => d.filePath === "data-flow-diagram",
                );
                const codeAnalogiesDiagram = additionalDiagrams.find(
                  (d) => d.filePath === "code-analogies-diagram",
                );

                // Insert data flow diagram after section 5
                if (dataFlowDiagram?.diagramUrl) {
                  finalContent = finalContent.replace(
                    /(<h2>5\. DATA FLOW ARCHITECTURE<\/h2>[\s\S]*?)(<h2>6\. CODE ANALOGIES)/,
                    `$1<div class="diagram"><img src="${dataFlowDiagram.diagramUrl}" alt="State & Props Flow Tree Structure" style="max-width: 100%; height: auto;"/></div>$2`,
                  );
                }

                // Insert code analogies diagram after section 6
                if (codeAnalogiesDiagram?.diagramUrl) {
                  finalContent = finalContent.replace(
                    /(<h2>6\. CODE ANALOGIES & EXPLANATIONS<\/h2>[\s\S]*?)(<h2>7\. LEARNING QUIZ)/,
                    `$1<div class="diagram"><img src="${codeAnalogiesDiagram.diagramUrl}" alt="Code Analogies & Visual Explanations" style="max-width: 100%; height: auto;"/></div>$2`,
                  );
                }

                // Don't separate content and resources - keep resources INSIDE content div
                return `
<div class="explanation">
  <h1>Comprehensive Repository Analysis for Interview Preparation</h1>
  <div class="content">
    ${finalContent}
  </div>
  <small><strong>Type:</strong> ${comprehensiveExplanation.explanationType} | <strong>Created:</strong> ${comprehensiveExplanation.createdAt}</small>
</div>`;
              } else {
                return '<div class="empty">No comprehensive analysis found. Use the MCP tool to generate analysis!</div>';
              }
            }
          )()
        }
    </div>
</body>
</html>`;

      return c.html(html);
    } else {
      return c.json({ explanations });
    }
  } catch (error) {
    return c.json(
      {
        error: "Failed to fetch explanations",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Get explanation details
app.get("/explanations/:id", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");

    const [explanation] = await db
      .select()
      .from(schema.explanations)
      .where(eq(schema.explanations.id, id));

    if (!explanation) {
      return c.json({ error: "Explanation not found" }, 404);
    }

    return c.json({ explanation });
  } catch (error) {
    return c.json(
      {
        error: "Failed to fetch explanation",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Generate quiz
app.post("/repositories/:id/quiz", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const genAI = new GoogleGenerativeAI(c.env.GOOGLE_AI_API_KEY);
    const id = c.req.param("id");
    const {
      explanation_ids,
      difficulty = "intermediate",
      question_count = 5,
    } = await c.req.json();

    // Get explanations
    const explanations = await db
      .select()
      .from(schema.explanations)
      .where(eq(schema.explanations.repositoryId, id));

    const relevantExplanations = explanation_ids
      ? explanations.filter((e) => explanation_ids.includes(e.id))
      : explanations.slice(0, 3);

    const explanationContent = relevantExplanations
      .map((e) => `Title: ${e.title}\nContent: ${e.content}`)
      .join("\n\n---\n\n");

    const prompt = `Based on these code explanations, generate ${question_count} ${difficulty} level quiz questions:

${explanationContent}

Generate questions that test understanding of:
- Code functionality and purpose
- Design patterns and best practices
- Security considerations (if applicable)
- Architecture and flow understanding

Format as JSON array with objects containing:
- id: unique identifier
- question: the question text
- options: array of 4 possible answers
- correctAnswer: the correct option
- explanation: brief explanation of why the answer is correct`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
    const response = await model.generateContent(prompt);

    let questions: Array<{
      id: string;
      question: string;
      options: string[];
      correctAnswer: string;
      explanation: string;
    }>;
    try {
      questions = JSON.parse(response.response.text());
    } catch {
      questions = [
        {
          id: "1",
          question: "What is the main purpose of this code?",
          options: [
            "Authentication",
            "Data processing",
            "UI rendering",
            "Error handling",
          ],
          correctAnswer: "Authentication",
          explanation:
            "Based on the code analysis, this appears to be an authentication flow.",
        },
      ];
    }

    const [quiz] = await db
      .insert(schema.quizzes)
      .values({
        repositoryId: id,
        explanationId: relevantExplanations[0]?.id || null,
        title: `Quiz: ${relevantExplanations[0]?.title || "Code Understanding"}`,
        questions,
      })
      .returning();

    return c.json({ quiz }, 201);
  } catch (error) {
    return c.json(
      {
        error: "Failed to generate quiz",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Submit quiz attempt
app.post("/quizzes/:id/attempt", async (c) => {
  try {
    const db = drizzle(c.env.DB);
    const id = c.req.param("id");
    const { answers, user_session } = await c.req.json();

    const [quiz] = await db
      .select()
      .from(schema.quizzes)
      .where(eq(schema.quizzes.id, id));

    if (!quiz) {
      return c.json({ error: "Quiz not found" }, 404);
    }

    // Calculate score
    let correctAnswers = 0;
    const userAnswerMap = new Map(
      (answers as Array<{ questionId: string; answer: string }>).map((a) => [
        a.questionId,
        a.answer,
      ]),
    );

    for (const question of quiz.questions ?? []) {
      const userAnswer = userAnswerMap.get(question.id);
      if (userAnswer === question.correctAnswer) {
        correctAnswers++;
      }
    }

    const totalQuestions = (quiz.questions ?? []).length;
    const score = Math.round((correctAnswers / totalQuestions) * 100);

    const [attempt] = await db
      .insert(schema.quizAttempts)
      .values({
        quizId: id,
        userSession: user_session,
        answers,
        score,
      })
      .returning();

    return c.json(
      {
        attempt,
        score,
        correctAnswers,
        totalQuestions,
        results: (quiz.questions ?? []).map((q) => ({
          questionId: q.id,
          question: q.question,
          userAnswer: userAnswerMap.get(q.id),
          correctAnswer: q.correctAnswer,
          isCorrect: userAnswerMap.get(q.id) === q.correctAnswer,
          explanation: q.explanation,
        })),
      },
      201,
    );
  } catch (error) {
    return c.json(
      {
        error: "Failed to submit quiz attempt",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// Create MCP server

function createMcpServer(env: Bindings) {
  const server = new McpServer({
    name: "code-explainer-tutor",
    version: "1.0.0",
    description:
      "MCP server for code analysis, explanation, and interactive learning",
  });

  const db = drizzle(env.DB);
  const genAI = new GoogleGenerativeAI(env.GOOGLE_AI_API_KEY);

  // Analyze repository tool - Comprehensive analysis for interview preparation
  server.tool(
    "analyze_repository",
    {
      source: z.string().describe("GitHub URL or 'upload' for file upload"),
      branch: z.string().optional().describe("Git branch (default: main)"),
    },
    async ({ source, branch = "main" }) => {
      try {
        let repositoryId: string;
        let repository:
          | {
            id: string;
            r2Path: string;
            name: string;
            languages: string[] | null;
          }
          | undefined;

        if (source.startsWith("https://github.com/")) {
          // Check if repository already exists
          const existingRepo = await db
            .select()
            .from(schema.repositories)
            .where(eq(schema.repositories.sourceUrl, source))
            .limit(1);

          if (existingRepo.length > 0) {
            // Repository already exists, use existing one
            repository = existingRepo[0];
            repositoryId = repository.id;
          } else {
            // Create new repository
            const { files, totalSize, repoName } = await fetchGitHubRepo(
              source,
              branch,
              env.GITHUB_TOKEN,
            );

            repositoryId = crypto.randomUUID();
            const r2Path = `repositories/${repositoryId}`;

            for (const [filePath, content] of files) {
              await env.R2.put(`${r2Path}/${filePath}`, content, {
                httpMetadata: { contentType: "text/plain" },
              });
            }

            const languages = detectLanguages(Array.from(files.keys()));

            [repository] = await db
              .insert(schema.repositories)
              .values({
                id: repositoryId,
                name: repoName,
                sourceType: "github",
                sourceUrl: source,
                fileCount: files.size,
                totalSize,
                languages,
                r2Path,
              })
              .returning();
          }
        } else {
          return {
            content: [
              {
                type: "text",
                text: "For file uploads, please use the web interface at /repositories/upload",
              },
            ],
          };
        }

        // Now perform comprehensive analysis using Gemini
        const filesList = await env.R2.list({
          prefix: `${repository.r2Path}/`,
        });
        const codeFiles: { path: string; content: string }[] = [];

        // Get relevant code files (limit to 15 files to avoid token limits)
        for (const file of filesList.objects.slice(0, 15)) {
          const key = file.key;
          if (
            key.match(
              /\.(js|ts|jsx|tsx|py|java|cpp|c|cs|php|rb|go|rs|swift|kt)$/,
            )
          ) {
            const object = await env.R2.get(key);
            if (object) {
              const content = await object.text();
              codeFiles.push({
                path: key.replace(`${repository.r2Path}/`, ""),
                content: content.slice(0, 3000), // Limit content size per file
              });
            }
          }
        }

        // Comprehensive analysis prompt
        const analysisPrompt = `You are a senior software engineer conducting a comprehensive code review for interview preparation. Analyze this repository thoroughly:

Repository: ${repository.name}
Source: ${source}
Files analyzed: ${codeFiles.length}
Languages: ${repository.languages?.join(", ")}

FILES CONTENT:
${codeFiles.map((f) => `=== ${f.path} ===\n${f.content}\n`).join("\n")}

Please provide a comprehensive analysis in the following format. Use proper markdown formatting:

## 1. APPLICATION SUMMARY
- What does this application do?
- What technologies, frameworks, and libraries are used?
- What is the overall architecture?
- What problem does it solve?

## 2. NOTABLE CODE SECTIONS (Interview Focus)
Identify 3-5 code sections that an interviewer might ask about:
- Complex algorithms or logic
- Design patterns used
- State management approaches
- API integrations
- Performance considerations
- Error handling patterns

## 3. AUTHENTICATION ANALYSIS
- Are there any authentication patterns?
- Security implementations?
- Authorization flows?
- Session management?
- If no auth: "No authentication patterns found"

## 4. PROJECT STRUCTURE
Describe the project structure and file organization in text format.

## 5. DATA FLOW ARCHITECTURE
Describe the data flow, shared state, and component relationships in text format. If state and props are not used in this application, explicitly state: "State and props are not used in this application."

## 6. CODE ANALOGIES & EXPLANATIONS
For each notable code section, provide:
- Simple analogy to explain the concept
- Why this pattern was chosen
- Potential interview questions about this code

## 7. LEARNING QUIZ QUESTIONS
Generate 10 technical interview questions based on this codebase. Focus on:
- Major technologies and frameworks used (React Hooks, Zustand, TypeScript, Hono.js, etc.)
- Core concepts that interviewers commonly ask about
- How these technologies are specifically implemented in this codebase
- Broader technical concepts that relate to the code

Mix specific application questions with general technical knowledge questions that a developer should know.

Format in this EXACT format:

**Question 1:** [Question text]
**Expected Answer:** [Answer]
**Follow-up:** [Follow-up question]

**Question 2:** [Question text]
**Expected Answer:** [Answer]
**Follow-up:** [Follow-up question]

[Continue for 10 questions]

## 8. SUPPLEMENTAL LEARNING RESOURCES
Provide 5-7 additional resources (documentation, articles, videos, tutorials) that would help someone learn more about the technologies and concepts used in this codebase:

**Resource 1:** [Title] - [URL] - [Brief description]
**Resource 2:** [Title] - [URL] - [Brief description]
[Continue for 5-7 resources]

Be thorough but concise. Focus on what would be most valuable for interview preparation.`;

        const model = genAI.getGenerativeModel({
          model: "gemini-2.0-flash-exp",
        });
        const response = await model.generateContent(analysisPrompt);

        const analysisResult = response.response.text();

        // Generate multiple diagrams for different sections
        const projectStructureDiagram = await generateDiagramImage(
          `Project structure and file organization for ${repository.name} - show folders, files, and architecture hierarchy`,
          env.GOOGLE_AI_API_KEY,
        );

        const dataFlowDiagram = await generateDiagramImage(
          `Data flow and state/props tree structure for ${repository.name} - show component relationships and data flow`,
          env.GOOGLE_AI_API_KEY,
        );

        const codeAnalogiesDiagram = await generateDiagramImage(
          `Code analogies and explanations diagram for ${repository.name} - visual representations of key concepts`,
          env.GOOGLE_AI_API_KEY,
        );

        // Save the comprehensive analysis with primary diagram
        await db.insert(schema.explanations).values({
          repositoryId,
          filePath: "comprehensive-analysis",
          explanationType: "comprehensive",
          title: "Comprehensive Repository Analysis for Interview Preparation",
          content: analysisResult,
          diagramUrl: projectStructureDiagram,
        });

        // Save additional diagrams as separate explanations
        if (dataFlowDiagram) {
          await db.insert(schema.explanations).values({
            repositoryId,
            filePath: "data-flow-diagram",
            explanationType: "diagram",
            title: "Data Flow & State/Props Architecture",
            content:
              "Tree-structure diagram showing data flow, shared state, and component relationships",
            diagramUrl: dataFlowDiagram,
          });
        }

        if (codeAnalogiesDiagram) {
          await db.insert(schema.explanations).values({
            repositoryId,
            filePath: "code-analogies-diagram",
            explanationType: "diagram",
            title: "Code Analogies & Visual Explanations",
            content: "Visual diagrams with analogies for notable code sections",
            diagramUrl: codeAnalogiesDiagram,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: `# 🎯 Comprehensive Code Analysis for Interview Preparation\n\n${analysisResult}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error analyzing repository: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Explain code tool
  server.tool(
    "explain_code",
    {
      repositoryId: z.string().describe("Repository ID"),
      filePath: z.string().describe("Path to the file"),
      startLine: z.number().optional().describe("Start line number"),
      endLine: z.number().optional().describe("End line number"),
      explanationType: z
        .enum(["overview", "function", "class", "flow"])
        .describe("Type of explanation"),
    },
    async ({ repositoryId, filePath, startLine, endLine, explanationType }) => {
      try {
        const [repository] = await db
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId));

        if (!repository) {
          return {
            content: [{ type: "text", text: "Repository not found" }],
            isError: true,
          };
        }

        const object = await env.R2.get(`${repository.r2Path}/${filePath}`);
        if (!object) {
          return {
            content: [{ type: "text", text: "File not found" }],
            isError: true,
          };
        }

        const fileContent = await object.text();
        const lines = fileContent.split("\n");
        const codeSection = lines
          .slice((startLine || 1) - 1, endLine || lines.length)
          .join("\n");

        const prompt = `Analyze this ${explanationType} code section and provide a comprehensive explanation:

File: ${filePath}
Code:
\`\`\`
${codeSection}
\`\`\`

Please provide a detailed explanation including:
1. What the code does
2. Key concepts and patterns
3. Security considerations if applicable
4. Best practices demonstrated or missing`;

        const model = genAI.getGenerativeModel({
          model: "gemini-2.0-flash-exp",
        });
        const response = await model.generateContent(prompt);

        const [explanation] = await db
          .insert(schema.explanations)
          .values({
            repositoryId,
            filePath,
            explanationType,
            title: `${explanationType} explanation for ${filePath}`,
            content: response.response.text(),
          })
          .returning();

        return {
          content: [
            {
              type: "text",
              text: `# ${explanation.title}\n\n${explanation.content}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error explaining code: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Generate quiz tool
  server.tool(
    "generate_quiz",
    {
      repositoryId: z.string().describe("Repository ID"),
      difficulty: z
        .enum(["beginner", "intermediate", "advanced"])
        .default("intermediate"),
      questionCount: z.number().min(1).max(10).default(5),
    },
    async ({ repositoryId, difficulty, questionCount }) => {
      try {
        const explanations = await db
          .select()
          .from(schema.explanations)
          .where(eq(schema.explanations.repositoryId, repositoryId));

        if (explanations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No explanations found. Please analyze some code first using the explain_code tool.",
              },
            ],
            isError: true,
          };
        }

        const explanationContent = explanations
          .slice(0, 3)
          .map((e) => `Title: ${e.title}\nContent: ${e.content}`)
          .join("\n\n---\n\n");

        const prompt = `Generate ${questionCount} ${difficulty} level quiz questions based on these code explanations:

${explanationContent}

Format as JSON array with objects containing:
- id: unique identifier
- question: the question text
- options: array of 4 possible answers
- correctAnswer: the correct option
- explanation: brief explanation`;

        const model = genAI.getGenerativeModel({
          model: "gemini-2.0-flash-exp",
        });
        const response = await model.generateContent(prompt);

        let questions: Array<{
          id: string;
          question: string;
          options: string[];
          correctAnswer: string;
          explanation: string;
        }>;
        try {
          questions = JSON.parse(response.response.text());
        } catch {
          questions = [
            {
              id: "1",
              question: "What is the main purpose of this code?",
              options: [
                "Authentication",
                "Data processing",
                "UI rendering",
                "Error handling",
              ],
              correctAnswer: "Authentication",
              explanation: "Based on the code analysis.",
            },
          ];
        }

        const [quiz] = await db
          .insert(schema.quizzes)
          .values({
            repositoryId,
            title: "Quiz: Code Understanding",
            questions,
          })
          .returning();

        const quizText = questions
          .map(
            (q, i: number) =>
              `${i + 1}. ${q.question}\n${q.options
                .map(
                  (opt: string, j: number) =>
                    `   ${String.fromCharCode(65 + j)}. ${opt}`,
                )
                .join("\n")}`,
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `# Quiz Generated (ID: ${quiz.id})\n\n${quizText}\n\nUse the web interface to submit answers and get your score!`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error generating quiz: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Analyze auth flow tool
  server.tool(
    "analyze_auth_flow",
    {
      repositoryId: z.string().describe("Repository ID"),
    },
    async ({ repositoryId }) => {
      try {
        const [repository] = await db
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId));

        if (!repository) {
          return {
            content: [{ type: "text", text: "Repository not found" }],
            isError: true,
          };
        }

        // List auth-related files
        const listing = await env.R2.list({ prefix: `${repository.r2Path}/` });
        const authFiles = listing.objects.filter((obj) => {
          const path = obj.key.toLowerCase();
          return (
            path.includes("auth") ||
            path.includes("login") ||
            path.includes("jwt") ||
            path.includes("oauth") ||
            path.includes("session") ||
            path.includes("middleware")
          );
        });

        if (authFiles.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No authentication-related files found in this repository.",
              },
            ],
          };
        }

        // Analyze the first few auth files
        let authCode = "";
        for (const file of authFiles.slice(0, 3)) {
          const object = await env.R2.get(file.key);
          if (object) {
            const content = await object.text();
            authCode += `\n\n=== ${file.key} ===\n${content}`;
          }
        }

        const prompt = `Analyze this authentication flow code and provide:

1. Authentication method used (JWT, OAuth, sessions, etc.)
2. Security strengths and potential vulnerabilities
3. Flow diagram in Mermaid syntax
4. Recommendations for improvement

Code:
${authCode}`;

        const model = genAI.getGenerativeModel({
          model: "gemini-2.0-flash-exp",
        });
        const response = await model.generateContent(prompt);

        const responseText = response.response.text();

        await db.insert(schema.explanations).values({
          repositoryId,
          filePath: "auth-flow-analysis",
          explanationType: "flow",
          title: "Authentication Flow Analysis",
          content: responseText,
        });

        return {
          content: [
            {
              type: "text",
              text: `# Authentication Flow Analysis\n\n${responseText}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error analyzing auth flow: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

// MCP endpoint
app.all("/mcp", async (c) => {
  const mcpServer = createMcpServer(c.env);
  const transport = new StreamableHTTPTransport();

  await mcpServer.connect(transport);
  return transport.handleRequest(c);
});

app.get("/openapi.json", (c) => {
  return c.json(
    createOpenAPISpec(app, {
      info: {
        title: "Code Explainer + Tutor API",
        version: "1.0.0",
        description:
          "API for code analysis, explanation generation, and interactive learning",
      },
    }),
  );
});

app.use(
  "/fp/*",
  createFiberplane({
    app,
    openapi: { url: "/openapi.json" },
  }),
);

export default app;
