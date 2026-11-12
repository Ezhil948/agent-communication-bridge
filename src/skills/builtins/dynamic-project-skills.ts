import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BaseSkill } from "../framework.js";
import { ShellExecuteSkill } from "./shell-execute.js";
import type { SkillContext } from "../../types/skills.js";

abstract class ShellDelegateSkill extends BaseSkill<{ query: string }, unknown> {
  readonly inputSchema = z.object({
    query: z.string().describe("Command or script name to run"),
  });

  private readonly shell = new ShellExecuteSkill();

  protected abstract resolveCommand(query: string, projectPath: string): string;

  async execute(input: { query: string }, context: SkillContext) {
    const command = this.resolveCommand(input.query, context.projectPath);
    const result = await this.shell.execute({ command, timeout: 60_000 }, context);
    const lines: string[] = [];
    if (result.stdout) lines.push(result.stdout.trimEnd());
    if (result.stderr) lines.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.timedOut) lines.push("[timed out]");
    return {
      text: lines.join("\n") || "(no output)",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  }
}

function detectPkgManager(projectPath: string): string {
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectPath, "yarn.lock"))) return "yarn";
  return "npm";
}

function detectTestCommand(projectPath: string): string {
  const pkgManager = detectPkgManager(projectPath);

  try {
    const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.test) return `${pkgManager} test`;
  } catch {
    /* ignore */
  }

  if (
    existsSync(join(projectPath, "vitest.config.ts")) ||
    existsSync(join(projectPath, "vitest.config.js"))
  ) {
    return "npx vitest run";
  }

  if (
    existsSync(join(projectPath, "jest.config.ts")) ||
    existsSync(join(projectPath, "jest.config.js"))
  ) {
    return "npx jest";
  }

  if (existsSync(join(projectPath, "pytest.ini")) || existsSync(join(projectPath, "pyproject.toml"))) {
    return "python -m pytest";
  }

  if (existsSync(join(projectPath, "pom.xml"))) return "mvn test";

  return `${pkgManager} test`;
}

export class RunScriptSkill extends ShellDelegateSkill {
  readonly id = "run-script";
  readonly name = "Run Script";
  readonly description = "Run a package.json script or shell command in the project directory. Returns stdout and stderr.";
  readonly tags = ["npm", "script", "build", "shell"];

  protected resolveCommand(query: string, projectPath: string): string {
    const pm = detectPkgManager(projectPath);
    const q = query.trim();

    if (/^[a-z0-9:_-]+$/i.test(q)) {
      try {
        const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        };
        if (pkg.scripts?.[q]) return `${pm} run ${q}`;
      } catch {
        /* ignore */
      }
    }

    return q;
  }
}

export class RunTestsSkill extends ShellDelegateSkill {
  readonly id = "run-tests";
  readonly name = "Run Tests";
  readonly description = "Run the project test suite and return results (stdout + stderr).";
  readonly tags = ["test", "ci", "quality"];

  protected resolveCommand(_query: string, projectPath: string): string {
    return detectTestCommand(projectPath);
  }
}

export class DockerBuildSkill extends ShellDelegateSkill {
  readonly id = "docker-build";
  readonly name = "Docker Build";
  readonly description = "Build the Docker image for this project using the Dockerfile.";
  readonly tags = ["docker", "build", "deploy"];

  protected resolveCommand(_query: string, _projectPath: string): string {
    return "docker build .";
  }
}

export class CodeReviewSkill extends ShellDelegateSkill {
  readonly id = "code-review";
  readonly name = "Code Review";
  readonly description = "Run static analysis and linting checks on the project codebase.";
  readonly tags = ["review", "quality", "analysis"];

  protected resolveCommand(_query: string, projectPath: string): string {
    const pm = detectPkgManager(projectPath);
    return `${pm} run lint`;
  }
}

export function detectDynamicSkills(projectPath: string): BaseSkill[] {
  const skills: BaseSkill[] = [];

  const hasTests = ["jest.config", "vitest.config", "pytest.ini", "pyproject.toml", "pom.xml"].some(
    (f) =>
      existsSync(join(projectPath, f)) ||
      existsSync(join(projectPath, f + ".ts")) ||
      existsSync(join(projectPath, f + ".js")),
  );
  if (hasTests) skills.push(new RunTestsSkill());

  if (existsSync(join(projectPath, "Dockerfile"))) skills.push(new DockerBuildSkill());

  if (existsSync(join(projectPath, "package.json"))) skills.push(new RunScriptSkill());

  if (existsSync(join(projectPath, "src"))) skills.push(new CodeReviewSkill());

  return skills;
}
