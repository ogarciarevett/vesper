# TradingRoom SDD Audit Evidence

- generated_at: 2026-02-14T21:36:53Z
- repo_root: /Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village

## Repository Status

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ git\ status\ --short 
```

```text
 M .dev.vars.example
M  .github/workflows/deploy.yml
MM README.md
R  apps/mission-control/README.md -> apps/agent-dashboard/README.md
R  apps/mission-control/index.html -> apps/agent-dashboard/index.html
R  apps/mission-control/package.json -> apps/agent-dashboard/package.json
A  apps/agent-dashboard/public/image.png
R  apps/mission-control/public/office.png -> apps/agent-dashboard/public/office.png
R  apps/mission-control/public/vite.svg -> apps/agent-dashboard/public/vite.svg
AM apps/agent-dashboard/src/App.tsx
R  apps/mission-control/src/assets/react.svg -> apps/agent-dashboard/src/assets/react.svg
R  apps/mission-control/src/hooks/useApiStatus.ts -> apps/agent-dashboard/src/hooks/useApiStatus.ts
AM apps/agent-dashboard/src/hooks/useBotStatus.ts
AM apps/agent-dashboard/src/hooks/useTradingSocket.ts
R  apps/mission-control/src/index.css -> apps/agent-dashboard/src/index.css
AM apps/agent-dashboard/src/lib/api.ts
R  apps/mission-control/src/main.tsx -> apps/agent-dashboard/src/main.tsx
R  apps/mission-control/src/views/OfficeView.tsx -> apps/agent-dashboard/src/views/OfficeView.tsx
R  apps/mission-control/tsconfig.app.json -> apps/agent-dashboard/tsconfig.app.json
R  apps/mission-control/tsconfig.json -> apps/agent-dashboard/tsconfig.json
R  apps/mission-control/tsconfig.node.json -> apps/agent-dashboard/tsconfig.node.json
R  apps/mission-control/vite.config.ts -> apps/agent-dashboard/vite.config.ts
R  apps/mission-control/wrangler.toml -> apps/agent-dashboard/wrangler.toml
MM apps/engine-api/package.json
A  apps/engine-api/src/connectors/CCXTConnector.ts
A  apps/engine-api/src/connectors/HyperliquidConnector.ts
A  apps/engine-api/src/connectors/MarketConnector.ts
A  apps/engine-api/src/connectors/PriceAggregator.ts
A  apps/engine-api/src/connectors/index.ts
MM apps/engine-api/src/durable-objects/BotInstance.ts
D  apps/engine-api/src/durable-objects/GameRoom.ts
AM apps/engine-api/src/durable-objects/TradingRoom.ts
MM apps/engine-api/src/env.d.ts
MM apps/engine-api/src/index.ts
A  apps/engine-api/src/risk/RiskManager.ts
A  apps/engine-api/src/risk/index.ts
M  apps/engine-api/src/skills/TradingStrategy.ts
A  apps/engine-api/src/skills/indicators/index.ts
A  apps/engine-api/src/skills/indicators/momentum.ts
A  apps/engine-api/src/skills/indicators/trend.ts
A  apps/engine-api/src/skills/indicators/volatility.ts
A  apps/engine-api/src/skills/indicators/volume.ts
A  apps/engine-api/src/skills/strategies/BreakoutHunter.ts
A  apps/engine-api/src/skills/strategies/FundingRateArbitrage.ts
A  apps/engine-api/src/skills/strategies/GridTrader.ts
A  apps/engine-api/src/skills/strategies/MeanReversion.ts
A  apps/engine-api/src/skills/strategies/MomentumScalper.ts
M  apps/engine-api/src/skills/strategies/SimpleStrategy.ts
A  apps/engine-api/src/skills/strategies/index.ts
M  apps/engine-api/tsconfig.json
M  apps/engine-api/worker-configuration.d.ts
M  apps/engine-api/wrangler.toml
D  apps/mission-control/src/App.css
D  apps/mission-control/src/App.tsx
D  apps/mission-control/src/components/NavButton.tsx
D  apps/mission-control/src/components/StatCard.tsx
D  apps/mission-control/src/hooks/useBotStatus.ts
D  apps/mission-control/src/hooks/useGameSocket.ts
D  apps/mission-control/src/lib/api.ts
D  apps/mission-control/src/views/AgentsView.tsx
D  apps/mission-control/src/views/GameView.tsx
D  apps/mission-control/src/views/TerminalView.tsx
M  bun.lock
 M package.json
 M packages/types/src/realtime.ts
M  packages/ui/package.json
AM specs/ARCHITECTURE_REVIEW.md
AM specs/QA_REPORT.md
AM specs/TRADINGROOM_SPEC.md
?? apps/engine-api/tests/
?? reports/
?? skills/

exit_code=0
```

## Root Scripts

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ cat\ package.json 
```

```text
{
	"name": "openclaw-village",
	"private": true,
	"config": {
		"commitizen": {
			"path": "./node_modules/cz-conventional-changelog"
		}
	},
	"scripts": {
		"build": "rimraf .turbo && turbo run build --force",
		"prepare": "husky",
		"commit": "turbo run lint test --filter=...[HEAD] --concurrency=1 && SKIP_PRECOMMIT=1 cz",
		"database:generate": "turbo run database:generate",
		"database:push": "turbo run database:push",
		"deploy": "turbo run deploy",
		"dev": "turbo run dev --parallel",
		"start": "turbo run start",
		"test": "turbo run test",
		"lint": "turbo run lint",
		"lint:fix": "turbo run lint:fix",
		"format": "prettier --write \"**/*.{ts,tsx,md}\"",
		"check-types": "turbo run check-types"
	},
	"devDependencies": {
		"@biomejs/biome": "2.3.8",
		"@commitlint/cli": "^20.4.1",
		"@commitlint/config-conventional": "^20.4.1",
		"commitizen": "^4.3.1",
		"cz-conventional-changelog": "^3.3.0",
		"husky": "^9.1.7",
		"prettier": "^3.6.2",
		"rimraf": "^6.1.2",
		"turbo": "^2.8.8",
		"typescript": "5.9.2"
	},
	"engines": {
		"node": ">=18"
	},
	"packageManager": "bun@1.2.20",
	"workspaces": [
		"apps/*",
		"packages/*"
	]
}

exit_code=0
```

## Turbo Build Dry-Run

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ ./node_modules/.bin/turbo\ run\ build\ --dry 
```

```text
• turbo 2.8.8

Packages in Scope
Name                    Path 
@repo/biome-config      packages/biome-config
@repo/hyperliquid-sdk   packages/hyperliquid-sdk
@repo/types             packages/types
@repo/typescript-config packages/typescript-config
@repo/ui                packages/ui
agent-dashboard         apps/agent-dashboard
engine-api              apps/engine-api

Global Hash Inputs
  Global Files                          = 0
  External Dependencies Hash            = 7039152662d3f4cf
  Global Cache Key                      = I can’t see ya, but I know you’re here
  Global Env Vars                       = 
  Global Env Vars Values                = 
  Inferred Global Env Vars Values       = 
  Global Passed Through Env Vars        = 
  Global Passed Through Env Vars Values = 
  Engines Values                        = node=>=18

Tasks to Run
@repo/biome-config#build
  Task                           = build
  Package                        = @repo/biome-config
  Hash                           = 2603114a20216590
  Cached (Local)                 = true
  Cached (Remote)                = false
  Directory                      = packages/biome-config
  Command                        = echo 'Add build script here'
  Outputs                        = .next/**, .wrangler/**, dist/**
  Log File                       = packages/biome-config/.turbo/turbo-build.log
  Dependencies                   = 
  Dependents                     = @repo/ui#build
  With                           = 
  Inputs Files Considered        = 5
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":["!.next/cache/**",".next/**",".wrangler/**","dist/**"],"cache":true,"dependsOn":["^build","^database:generate"],"inputs":["$TURBO_DEFAULT$",".env*"],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/biome-config#database:generate
  Task                           = database:generate
  Package                        = @repo/biome-config
  Hash                           = e994cfa6585ba02a
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/biome-config
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = 
  Dependencies                   = 
  Dependents                     = @repo/ui#build
  With                           = 
  Inputs Files Considered        = 5
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":false,"dependsOn":[],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/hyperliquid-sdk#build
  Task                           = build
  Package                        = @repo/hyperliquid-sdk
  Hash                           = 09afc1c2c989e01d
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/hyperliquid-sdk
  Command                        = <NONEXISTENT>
  Outputs                        = .next/**, .wrangler/**, dist/**
  Log File                       = packages/hyperliquid-sdk/.turbo/turbo-build.log
  Dependencies                   = @repo/types#build, @repo/types#database:generate, @repo/typescript-config#build, @repo/typescript-config#database:generate
  Dependents                     = engine-api#build
  With                           = 
  Inputs Files Considered        = 10
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":["!.next/cache/**",".next/**",".wrangler/**","dist/**"],"cache":true,"dependsOn":["^build","^database:generate"],"inputs":["$TURBO_DEFAULT$",".env*"],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/hyperliquid-sdk#database:generate
  Task                           = database:generate
  Package                        = @repo/hyperliquid-sdk
  Hash                           = 67e85c5c70879a9f
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/hyperliquid-sdk
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = 
  Dependencies                   = 
  Dependents                     = engine-api#build
  With                           = 
  Inputs Files Considered        = 10
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":false,"dependsOn":[],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/types#build
  Task                           = build
  Package                        = @repo/types
  Hash                           = efd88612b6363956
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/types
  Command                        = <NONEXISTENT>
  Outputs                        = .next/**, .wrangler/**, dist/**
  Log File                       = packages/types/.turbo/turbo-build.log
  Dependencies                   = @repo/typescript-config#build, @repo/typescript-config#database:generate
  Dependents                     = @repo/hyperliquid-sdk#build, agent-dashboard#build, engine-api#build
  With                           = 
  Inputs Files Considered        = 7
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":["!.next/cache/**",".next/**",".wrangler/**","dist/**"],"cache":true,"dependsOn":["^build","^database:generate"],"inputs":["$TURBO_DEFAULT$",".env*"],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/types#database:generate
  Task                           = database:generate
  Package                        = @repo/types
  Hash                           = fad6a25b2f3240d5
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/types
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = 
  Dependencies                   = 
  Dependents                     = @repo/hyperliquid-sdk#build, agent-dashboard#build, engine-api#build
  With                           = 
  Inputs Files Considered        = 7
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":false,"dependsOn":[],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/typescript-config#build
  Task                           = build
  Package                        = @repo/typescript-config
  Hash                           = 3816a122e011c05d
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/typescript-config
  Command                        = <NONEXISTENT>
  Outputs                        = .next/**, .wrangler/**, dist/**
  Log File                       = packages/typescript-config/.turbo/turbo-build.log
  Dependencies                   = 
  Dependents                     = @repo/hyperliquid-sdk#build, @repo/types#build, @repo/ui#build
  With                           = 
  Inputs Files Considered        = 4
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":["!.next/cache/**",".next/**",".wrangler/**","dist/**"],"cache":true,"dependsOn":["^build","^database:generate"],"inputs":["$TURBO_DEFAULT$",".env*"],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/typescript-config#database:generate
  Task                           = database:generate
  Package                        = @repo/typescript-config
  Hash                           = 11dd114006d5717d
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/typescript-config
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = 
  Dependencies                   = 
  Dependents                     = @repo/hyperliquid-sdk#build, @repo/types#build, @repo/ui#build
  With                           = 
  Inputs Files Considered        = 4
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":false,"dependsOn":[],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/ui#build
  Task                           = build
  Package                        = @repo/ui
  Hash                           = ec9faed8c663add1
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/ui
  Command                        = <NONEXISTENT>
  Outputs                        = .next/**, .wrangler/**, dist/**
  Log File                       = packages/ui/.turbo/turbo-build.log
  Dependencies                   = @repo/biome-config#build, @repo/biome-config#database:generate, @repo/typescript-config#build, @repo/typescript-config#database:generate
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 7
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":["!.next/cache/**",".next/**",".wrangler/**","dist/**"],"cache":true,"dependsOn":["^build","^database:generate"],"inputs":["$TURBO_DEFAULT$",".env*"],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
agent-dashboard#build
  Task                           = build
  Package                        = agent-dashboard
  Hash                           = 095946e39300b96e
  Cached (Local)                 = true
  Cached (Remote)                = false
  Directory                      = apps/agent-dashboard
  Command                        = tsc -b && vite build
  Outputs                        = .next/**, .wrangler/**, dist/**
  Log File                       = apps/agent-dashboard/.turbo/turbo-build.log
  Dependencies                   = @repo/types#build, @repo/types#database:generate
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 20
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":["!.next/cache/**",".next/**",".wrangler/**","dist/**"],"cache":true,"dependsOn":["^build","^database:generate"],"inputs":["$TURBO_DEFAULT$",".env*"],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = vite
engine-api#build
  Task                           = build
  Package                        = engine-api
  Hash                           = 64a994d671869f95
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = apps/engine-api
  Command                        = <NONEXISTENT>
  Outputs                        = .next/**, .wrangler/**, dist/**
  Log File                       = apps/engine-api/.turbo/turbo-build.log
  Dependencies                   = @repo/hyperliquid-sdk#build, @repo/hyperliquid-sdk#database:generate, @repo/types#build, @repo/types#database:generate
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 36
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":["!.next/cache/**",".next/**",".wrangler/**","dist/**"],"cache":true,"dependsOn":["^build","^database:generate"],"inputs":["$TURBO_DEFAULT$",".env*"],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 

exit_code=0
```

## Turbo Test Dry-Run

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ ./node_modules/.bin/turbo\ run\ test\ --dry 
```

```text
• turbo 2.8.8

Packages in Scope
Name                    Path 
@repo/biome-config      packages/biome-config
@repo/hyperliquid-sdk   packages/hyperliquid-sdk
@repo/types             packages/types
@repo/typescript-config packages/typescript-config
@repo/ui                packages/ui
agent-dashboard         apps/agent-dashboard
engine-api              apps/engine-api

Global Hash Inputs
  Global Files                          = 0
  External Dependencies Hash            = 7039152662d3f4cf
  Global Cache Key                      = I can’t see ya, but I know you’re here
  Global Env Vars                       = 
  Global Env Vars Values                = 
  Inferred Global Env Vars Values       = 
  Global Passed Through Env Vars        = 
  Global Passed Through Env Vars Values = 
  Engines Values                        = node=>=18

Tasks to Run
@repo/biome-config#database:generate
  Task                           = database:generate
  Package                        = @repo/biome-config
  Hash                           = e994cfa6585ba02a
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/biome-config
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = 
  Dependencies                   = 
  Dependents                     = @repo/ui#test
  With                           = 
  Inputs Files Considered        = 5
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":false,"dependsOn":[],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/biome-config#test
  Task                           = test
  Package                        = @repo/biome-config
  Hash                           = b8c01d2a02d7c040
  Cached (Local)                 = true
  Cached (Remote)                = false
  Directory                      = packages/biome-config
  Command                        = echo 'Add test script here'
  Outputs                        = 
  Log File                       = packages/biome-config/.turbo/turbo-test.log
  Dependencies                   = 
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 5
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":true,"dependsOn":["^database:generate"],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/hyperliquid-sdk#database:generate
  Task                           = database:generate
  Package                        = @repo/hyperliquid-sdk
  Hash                           = 67e85c5c70879a9f
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/hyperliquid-sdk
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = 
  Dependencies                   = 
  Dependents                     = engine-api#test
  With                           = 
  Inputs Files Considered        = 10
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":false,"dependsOn":[],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/hyperliquid-sdk#test
  Task                           = test
  Package                        = @repo/hyperliquid-sdk
  Hash                           = c35dd4c496404c13
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/hyperliquid-sdk
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = packages/hyperliquid-sdk/.turbo/turbo-test.log
  Dependencies                   = @repo/types#database:generate, @repo/typescript-config#database:generate
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 10
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":true,"dependsOn":["^database:generate"],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/types#database:generate
  Task                           = database:generate
  Package                        = @repo/types
  Hash                           = fad6a25b2f3240d5
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/types
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = 
  Dependencies                   = 
  Dependents                     = @repo/hyperliquid-sdk#test, agent-dashboard#test, engine-api#test
  With                           = 
  Inputs Files Considered        = 7
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":false,"dependsOn":[],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/types#test
  Task                           = test
  Package                        = @repo/types
  Hash                           = d5b03df26a7ae0ed
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/types
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = packages/types/.turbo/turbo-test.log
  Dependencies                   = @repo/typescript-config#database:generate
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 7
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":true,"dependsOn":["^database:generate"],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/typescript-config#database:generate
  Task                           = database:generate
  Package                        = @repo/typescript-config
  Hash                           = 11dd114006d5717d
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/typescript-config
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = 
  Dependencies                   = 
  Dependents                     = @repo/hyperliquid-sdk#test, @repo/types#test, @repo/ui#test
  With                           = 
  Inputs Files Considered        = 4
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":false,"dependsOn":[],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/typescript-config#test
  Task                           = test
  Package                        = @repo/typescript-config
  Hash                           = c72ea6d6003b08d0
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/typescript-config
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = packages/typescript-config/.turbo/turbo-test.log
  Dependencies                   = 
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 4
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":true,"dependsOn":["^database:generate"],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
@repo/ui#test
  Task                           = test
  Package                        = @repo/ui
  Hash                           = 63e2c975e41b0737
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = packages/ui
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = packages/ui/.turbo/turbo-test.log
  Dependencies                   = @repo/biome-config#database:generate, @repo/typescript-config#database:generate
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 7
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":true,"dependsOn":["^database:generate"],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 
agent-dashboard#test
  Task                           = test
  Package                        = agent-dashboard
  Hash                           = 757f3b0e44b2405a
  Cached (Local)                 = false
  Cached (Remote)                = false
  Directory                      = apps/agent-dashboard
  Command                        = <NONEXISTENT>
  Outputs                        = 
  Log File                       = apps/agent-dashboard/.turbo/turbo-test.log
  Dependencies                   = @repo/types#database:generate
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 20
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":true,"dependsOn":["^database:generate"],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = vite
engine-api#test
  Task                           = test
  Package                        = engine-api
  Hash                           = 90730acef246b6c6
  Cached (Local)                 = true
  Cached (Remote)                = false
  Directory                      = apps/engine-api
  Command                        = bun test tests
  Outputs                        = 
  Log File                       = apps/engine-api/.turbo/turbo-test.log
  Dependencies                   = @repo/hyperliquid-sdk#database:generate, @repo/types#database:generate
  Dependents                     = 
  With                           = 
  Inputs Files Considered        = 36
  Env Vars                       = 
  Env Vars Values                = 
  Inferred Env Vars Values       = 
  Passed Through Env Vars        = 
  Passed Through Env Vars Values = 
  Resolved Task Definition       = {"outputs":[],"cache":true,"dependsOn":["^database:generate"],"inputs":[],"outputLogs":"full","persistent":false,"interruptible":false,"env":[],"passThroughEnv":null,"interactive":false}
  Framework                      = 

exit_code=0
```

## Legacy Naming Drift Scan

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ rg\ -n\ \'mission-control\|GameRoom\|useGameSocket\'\ README.md\ specs\ apps\ \|\|\ true 
```

```text
specs/ARCHITECTURE_REVIEW.md:37:- WebSocket layer (GameRoom) is a non-functional placeholder -- critical gap
specs/ARCHITECTURE_REVIEW.md:102:**File: `src/durable-objects/GameRoom.ts`**
specs/ARCHITECTURE_REVIEW.md:145:- `GameRoom.sessions: Map<WebSocket, any>` -- session metadata is untyped
specs/ARCHITECTURE_REVIEW.md:153:**GameRoom.ts** is a minimal broadcast room with no protocol, no state management, and no connection to the bot execution system.
specs/ARCHITECTURE_REVIEW.md:169:**None of this is implemented.** The GameRoom just re-broadcasts raw strings.
specs/ARCHITECTURE_REVIEW.md:173:- BotInstance never sends state changes to GameRoom
specs/ARCHITECTURE_REVIEW.md:174:- GameRoom has no reference to BotInstance DOs
specs/ARCHITECTURE_REVIEW.md:191:Rename `GameRoom` to `TradingRoom` and implement the following:
specs/ARCHITECTURE_REVIEW.md:230:class_name = "TradingRoom"  # was GameRoom
specs/ARCHITECTURE_REVIEW.md:235:renamed_classes = [{from = "GameRoom", to = "TradingRoom"}]
specs/ARCHITECTURE_REVIEW.md:623:- WebSocket connections bypass CORS entirely (by spec). The `Upgrade` check on line 13 of `GameRoom.ts` helps but isn't security.
specs/ARCHITECTURE_REVIEW.md:694:   - Rename GameRoom to TradingRoom
specs/TRADINGROOM_SPEC.md:57:The TradingRoom is a Cloudflare Durable Object that serves as the central coordinator for a group of trading bots. It replaces the current `GameRoom` implementation.
specs/TRADINGROOM_SPEC.md:213:| TradingRoom DO | `GameRoom` (`apps/engine-api/src/durable-objects/GameRoom.ts`) | Rename to `TradingRoom`, add bot registry, state aggregation, protocol parsing |
specs/TRADINGROOM_SPEC.md:1303:# Rename GameRoom to TradingRoom
specs/TRADINGROOM_SPEC.md:1306:class_name = "TradingRoom"     # was: GameRoom
specs/TRADINGROOM_SPEC.md:1315:renamed_classes = [{from = "GameRoom", to = "TradingRoom"}]
apps/engine-api/wrangler.toml:19:new_classes = ["GameRoom", "BotInstance"]
apps/engine-api/wrangler.toml:23:renamed_classes = [{from = "GameRoom", to = "TradingRoom"}]

exit_code=0
```

## Realtime Contract Scan

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ rg\ -n\ \'ROOM_STATE\|TRADE_EVENT\|FULL_STATE\|STATE_DELTA\|agentId\|doId\'\ packages/types\ apps/engine-api\ apps/agent-dashboard\ \|\|\ true 
```

```text
packages/types/src/realtime.ts:21:	type: "STATE_DELTA";
packages/types/src/realtime.ts:22:	agentId: string;
packages/types/src/realtime.ts:30:	type: "FULL_STATE";
packages/types/src/realtime.ts:31:	agentId: string;
packages/types/src/realtime.ts:52:	type: "ROOM_STATE";
packages/types/src/realtime.ts:65:	type: "TRADE_EVENT";
packages/types/src/realtime.ts:66:	agentId: string;
packages/types/src/realtime.ts:75:	agentId: string;
packages/types/src/realtime.ts:81:	agentId: string;
packages/types/src/realtime.ts:91:	agentId: string;
packages/types/src/realtime.ts:92:	doId?: string;
apps/engine-api/src/index.ts:13:  agentId: string;
apps/engine-api/src/index.ts:102:    const exact = bots.find((entry) => entry.agentId === botIdOrAlias);
apps/engine-api/src/index.ts:103:    if (exact) return exact.agentId;
apps/engine-api/src/index.ts:107:      entry.agentId.toLowerCase().endsWith(`-${lowered}`),
apps/engine-api/src/index.ts:109:    if (suffix) return suffix.agentId;
apps/engine-api/src/index.ts:209:    doId: id.toString(),
apps/engine-api/src/index.ts:282:        agentId: botName,
apps/engine-api/src/index.ts:285:        doId: botDoId.toString(),
apps/engine-api/src/index.ts:293:    doId: botDoId.toString(),
apps/engine-api/src/index.ts:302:  const doId = c.env.BOT_INSTANCE.idFromName(botId);
apps/engine-api/src/index.ts:303:  const stub = c.env.BOT_INSTANCE.get(doId);
apps/engine-api/src/index.ts:326:  const doId = c.env.BOT_INSTANCE.idFromName(botId);
apps/engine-api/src/index.ts:327:  const stub = c.env.BOT_INSTANCE.get(doId);
apps/engine-api/src/index.ts:337:  const doId = c.env.BOT_INSTANCE.idFromName(botId);
apps/engine-api/src/index.ts:338:  const stub = c.env.BOT_INSTANCE.get(doId);
apps/engine-api/src/index.ts:348:  const doId = c.env.BOT_INSTANCE.idFromName(botId);
apps/engine-api/src/index.ts:349:  const stub = c.env.BOT_INSTANCE.get(doId);
apps/engine-api/src/index.ts:359:  const doId = c.env.BOT_INSTANCE.idFromName(botId);
apps/engine-api/src/index.ts:360:  const stub = c.env.BOT_INSTANCE.get(doId);
apps/engine-api/src/index.ts:370:  const doId = c.env.BOT_INSTANCE.idFromName(botId);
apps/engine-api/src/index.ts:371:  const stub = c.env.BOT_INSTANCE.get(doId);
apps/engine-api/src/index.ts:381:  const doId = c.env.BOT_INSTANCE.idFromName(botId);
apps/engine-api/src/index.ts:382:  const stub = c.env.BOT_INSTANCE.get(doId);
apps/engine-api/src/index.ts:392:  const doId = c.env.BOT_INSTANCE.idFromName(botId);
apps/engine-api/src/index.ts:393:  const stub = c.env.BOT_INSTANCE.get(doId);
apps/agent-dashboard/src/lib/api.ts:61:    agentId: string;
apps/agent-dashboard/src/lib/api.ts:64:    doId: string;
apps/agent-dashboard/src/lib/api.ts:80:  doId: string;
apps/agent-dashboard/src/lib/api.ts:87:  doId: string;
apps/agent-dashboard/src/lib/api.ts:97:    agentId: string;
apps/agent-dashboard/src/lib/api.ts:98:    doId: string;
packages/types/src/trading.ts:35:	agentId: string;
packages/types/src/trading.ts:60:	agentId: string;
packages/types/src/logs.ts:15:	agentId: string;
packages/types/src/agent.ts:31:	agentId: string;
apps/agent-dashboard/src/hooks/useTradingSocket.ts:11:/** Room-level aggregated state from ROOM_STATE messages */
apps/agent-dashboard/src/hooks/useTradingSocket.ts:22:/** Trade event from TRADE_EVENT messages */
apps/agent-dashboard/src/hooks/useTradingSocket.ts:24:  agentId: string;
apps/agent-dashboard/src/hooks/useTradingSocket.ts:70:      case "FULL_STATE": {
apps/agent-dashboard/src/hooks/useTradingSocket.ts:72:          type: "FULL_STATE";
apps/agent-dashboard/src/hooks/useTradingSocket.ts:73:          agentId: string;
apps/agent-dashboard/src/hooks/useTradingSocket.ts:78:          next.set(fullState.agentId, fullState.state);
apps/agent-dashboard/src/hooks/useTradingSocket.ts:84:      case "STATE_DELTA": {
apps/agent-dashboard/src/hooks/useTradingSocket.ts:86:          type: "STATE_DELTA";
apps/agent-dashboard/src/hooks/useTradingSocket.ts:87:          agentId: string;
apps/agent-dashboard/src/hooks/useTradingSocket.ts:91:          const existing = prev.get(delta.agentId);
apps/agent-dashboard/src/hooks/useTradingSocket.ts:94:          next.set(delta.agentId, { ...existing, ...delta.changes });
apps/agent-dashboard/src/hooks/useTradingSocket.ts:100:      case "ROOM_STATE": {
apps/agent-dashboard/src/hooks/useTradingSocket.ts:101:        const room = msg as unknown as { type: "ROOM_STATE" } & RoomState;
apps/agent-dashboard/src/hooks/useTradingSocket.ts:114:      case "TRADE_EVENT": {
apps/agent-dashboard/src/hooks/useTradingSocket.ts:116:          type: "TRADE_EVENT";
apps/agent-dashboard/src/hooks/useTradingSocket.ts:117:          agentId: string;
apps/agent-dashboard/src/hooks/useTradingSocket.ts:125:              agentId: trade.agentId,
apps/agent-dashboard/src/hooks/useTradingSocket.ts:234:  const subscribe = useCallback((agentId: string) => {
apps/agent-dashboard/src/hooks/useTradingSocket.ts:237:      const msg: ClientMessage = { type: "SUBSCRIBE", agentId };
apps/agent-dashboard/src/hooks/useTradingSocket.ts:242:  const unsubscribe = useCallback((agentId: string) => {
apps/agent-dashboard/src/hooks/useTradingSocket.ts:245:      const msg: ClientMessage = { type: "UNSUBSCRIBE", agentId };
apps/agent-dashboard/src/App.tsx:108:function toPublicBotId(agentId: string): string {
apps/agent-dashboard/src/App.tsx:109:  const parts = agentId.split("-");
apps/agent-dashboard/src/App.tsx:120:  return agentId;
apps/agent-dashboard/src/App.tsx:332:            id: bot.agentId,
apps/agent-dashboard/src/App.tsx:333:            publicId: toPublicBotId(bot.agentId),
apps/agent-dashboard/src/App.tsx:334:            name: bot.name || toDisplayName(bot.agentId),
apps/agent-dashboard/src/App.tsx:624:                        botName={botNameMap.get(event.agentId) ?? event.agentId}
apps/engine-api/tests/tradingroom.integration.test.ts:120:      const fullState = await waitForMessage(ws, (msg) => msg.type === "FULL_STATE");
apps/engine-api/tests/tradingroom.integration.test.ts:121:      expect(fullState.type).toBe("FULL_STATE");
apps/engine-api/tests/tradingroom.integration.test.ts:129:        results: Array<{ agentId: string }>;
apps/engine-api/tests/tradingroom.integration.test.ts:134:        emergency.data.results.some((r) => r.agentId === createBot.data.botId),
apps/engine-api/src/durable-objects/TradingRoom.ts:19:  agentId: string;
apps/engine-api/src/durable-objects/TradingRoom.ts:22:  doId: string;
apps/engine-api/src/durable-objects/TradingRoom.ts:53:  agentId: string;
apps/engine-api/src/durable-objects/TradingRoom.ts:54:  doId: string;
apps/engine-api/src/durable-objects/TradingRoom.ts:65:  /** Cached bot states for FULL_STATE on connect/subscribe */
apps/engine-api/src/durable-objects/TradingRoom.ts:114:  private nextSeq(agentId: string): number {
apps/engine-api/src/durable-objects/TradingRoom.ts:115:    const current = this.seqCounters.get(agentId) ?? 0;
apps/engine-api/src/durable-objects/TradingRoom.ts:117:    this.seqCounters.set(agentId, next);
apps/engine-api/src/durable-objects/TradingRoom.ts:129:  private sendFullState(ws: WebSocket, agentId: string): void {
apps/engine-api/src/durable-objects/TradingRoom.ts:130:    const state = this.botStates.get(agentId);
apps/engine-api/src/durable-objects/TradingRoom.ts:134:      type: "FULL_STATE",
apps/engine-api/src/durable-objects/TradingRoom.ts:135:      agentId,
apps/engine-api/src/durable-objects/TradingRoom.ts:136:      seq: this.nextSeq(agentId),
apps/engine-api/src/durable-objects/TradingRoom.ts:149:      type: "ROOM_STATE",
apps/engine-api/src/durable-objects/TradingRoom.ts:158:    agentId: string,
apps/engine-api/src/durable-objects/TradingRoom.ts:162:      type: "TRADE_EVENT",
apps/engine-api/src/durable-objects/TradingRoom.ts:163:      agentId,
apps/engine-api/src/durable-objects/TradingRoom.ts:170:      if (meta.subscriptions.has(agentId) || meta.subscriptions.size === 0) {
apps/engine-api/src/durable-objects/TradingRoom.ts:274:    // Send FULL_STATE for every registered bot on connect
apps/engine-api/src/durable-objects/TradingRoom.ts:275:    for (const agentId of this.botStates.keys()) {
apps/engine-api/src/durable-objects/TradingRoom.ts:276:      this.sendFullState(server, agentId);
apps/engine-api/src/durable-objects/TradingRoom.ts:292:      agentId: string;
apps/engine-api/src/durable-objects/TradingRoom.ts:298:    const { agentId, state, changes, tradeEvent } = body;
apps/engine-api/src/durable-objects/TradingRoom.ts:299:    if (!agentId) {
apps/engine-api/src/durable-objects/TradingRoom.ts:301:        { ok: false, message: "agentId is required" },
apps/engine-api/src/durable-objects/TradingRoom.ts:308:      this.botStates.set(agentId, state);
apps/engine-api/src/durable-objects/TradingRoom.ts:309:      // Broadcast FULL_STATE to subscribers
apps/engine-api/src/durable-objects/TradingRoom.ts:311:        if (meta.subscriptions.has(agentId) || meta.subscriptions.size === 0) {
apps/engine-api/src/durable-objects/TradingRoom.ts:312:          this.sendFullState(ws, agentId);
apps/engine-api/src/durable-objects/TradingRoom.ts:319:      const existing = this.botStates.get(agentId);
apps/engine-api/src/durable-objects/TradingRoom.ts:323:        this.botStates.set(agentId, existing);
apps/engine-api/src/durable-objects/TradingRoom.ts:325:      this.broadcastDelta(agentId, changes);
apps/engine-api/src/durable-objects/TradingRoom.ts:329:      this.broadcastTradeEvent(agentId, tradeEvent);
apps/engine-api/src/durable-objects/TradingRoom.ts:340:      agentId: string;
apps/engine-api/src/durable-objects/TradingRoom.ts:343:      doId: string;
apps/engine-api/src/durable-objects/TradingRoom.ts:345:    if (!body.agentId || !body.doId) {
apps/engine-api/src/durable-objects/TradingRoom.ts:347:        { ok: false, message: "agentId and doId are required" },
apps/engine-api/src/durable-objects/TradingRoom.ts:357:    const existing = registry.find((e) => e.agentId === body.agentId);
apps/engine-api/src/durable-objects/TradingRoom.ts:361:      existing.doId = body.doId || existing.doId;
apps/engine-api/src/durable-objects/TradingRoom.ts:368:      agentId: body.agentId,
apps/engine-api/src/durable-objects/TradingRoom.ts:371:      doId: body.doId,
apps/engine-api/src/durable-objects/TradingRoom.ts:477:          const botId = this._env.BOT_INSTANCE.idFromString(entry.doId);
apps/engine-api/src/durable-objects/TradingRoom.ts:481:              `https://internal/api/bot/${encodeURIComponent(entry.agentId)}/stop`,
apps/engine-api/src/durable-objects/TradingRoom.ts:495:            agentId: entry.agentId,
apps/engine-api/src/durable-objects/TradingRoom.ts:496:            doId: entry.doId,
apps/engine-api/src/durable-objects/TradingRoom.ts:505:            const cached = this.botStates.get(entry.agentId);
apps/engine-api/src/durable-objects/TradingRoom.ts:510:              this.botStates.set(entry.agentId, cached);
apps/engine-api/src/durable-objects/TradingRoom.ts:515:            agentId: entry.agentId,
apps/engine-api/src/durable-objects/TradingRoom.ts:516:            doId: entry.doId,
apps/engine-api/src/durable-objects/TradingRoom.ts:553:  /** Broadcast a STATE_DELTA to all sessions subscribed to this agent */
apps/engine-api/src/durable-objects/TradingRoom.ts:555:    agentId: string,
apps/engine-api/src/durable-objects/TradingRoom.ts:559:      type: "STATE_DELTA",
apps/engine-api/src/durable-objects/TradingRoom.ts:560:      agentId,
apps/engine-api/src/durable-objects/TradingRoom.ts:561:      seq: this.nextSeq(agentId),
apps/engine-api/src/durable-objects/TradingRoom.ts:568:      if (meta.subscriptions.has(agentId) || meta.subscriptions.size === 0) {
apps/engine-api/src/durable-objects/TradingRoom.ts:597:        meta.subscriptions.add(parsed.agentId);
apps/engine-api/src/durable-objects/TradingRoom.ts:598:        // Send FULL_STATE for the newly subscribed agent
apps/engine-api/src/durable-objects/TradingRoom.ts:599:        this.sendFullState(ws, parsed.agentId);
apps/engine-api/src/durable-objects/TradingRoom.ts:604:        meta.subscriptions.delete(parsed.agentId);
apps/engine-api/src/durable-objects/BotInstance.ts:30:  agentId: string;
apps/engine-api/src/durable-objects/BotInstance.ts:31:  doId: string;
apps/engine-api/src/durable-objects/BotInstance.ts:118:    const doId = this.ctx.id.toString();
apps/engine-api/src/durable-objects/BotInstance.ts:120:      agentId: doId,
apps/engine-api/src/durable-objects/BotInstance.ts:121:      doId,
apps/engine-api/src/durable-objects/BotInstance.ts:329:    this.botState.doId = this.ctx.id.toString();
apps/engine-api/src/durable-objects/BotInstance.ts:334:    this.botState.doId = this.ctx.id.toString();
apps/engine-api/src/durable-objects/BotInstance.ts:345:    if (routeAgentId && this.botState.agentId !== routeAgentId) {
apps/engine-api/src/durable-objects/BotInstance.ts:346:      this.botState.agentId = routeAgentId;
apps/engine-api/src/durable-objects/BotInstance.ts:459:      agentId: this.botState.agentId,
apps/engine-api/src/durable-objects/BotInstance.ts:460:      doId: this.ctx.id.toString(),
apps/engine-api/src/durable-objects/BotInstance.ts:497:        `Bot ${this.botState.agentId} hit circuit breaker after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Stopping.`,
apps/engine-api/src/durable-objects/BotInstance.ts:546:        `[Bot:${this.botState.agentId}] Signal: ${signal.action} (confidence: ${signal.confidence})`,
apps/engine-api/src/durable-objects/BotInstance.ts:1004:    await this.storage.saveLog(this.botState.agentId || this.ctx.id.toString(), entry);
apps/engine-api/src/durable-objects/BotInstance.ts:1018:      agentId: this.botState.agentId,
apps/engine-api/src/durable-objects/BotInstance.ts:1019:      doId: this.ctx.id.toString(),
apps/engine-api/src/durable-objects/BotInstance.ts:1051:            agentId: this.botState.agentId,
apps/engine-api/src/durable-objects/BotInstance.ts:1078:            agentId: this.botState.agentId,
apps/engine-api/src/durable-objects/BotInstance.ts:1097:        doId: this.ctx.id.toString(),
apps/engine-api/src/durable-objects/BotInstance.ts:1113:            agentId: this.botState.agentId,

exit_code=0
```

## Auth Coverage Scan

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ rg\ -n\ \'OPENCLAW_GATEWAY_PASSWORD\|x-openclaw-gateway-password\|gateway_password\'\ apps/engine-api\ apps/agent-dashboard\ .dev.vars.example\ README.md\ \|\|\ true 
```

```text
.dev.vars.example:13:OPENCLAW_GATEWAY_PASSWORD="your-local-gateway-password"
README.md:33:    `OPENCLAW_GATEWAY_PASSWORD` is required because all `/api/*` and WS upgrade routes enforce shared-secret auth.
README.md:84:bunx wrangler secret put OPENCLAW_GATEWAY_PASSWORD
README.md:153:- `OPENCLAW_GATEWAY_PASSWORD` is set
apps/engine-api/src/index.ts:10:const GATEWAY_PASSWORD_HEADER = "x-openclaw-gateway-password";
apps/engine-api/src/index.ts:32:  const queryPassword = url.searchParams.get("gateway_password");
apps/engine-api/src/index.ts:120:  allowHeaders: ["Content-Type", "Upgrade", "Authorization", "x-openclaw-gateway-password"],
apps/engine-api/src/index.ts:131:  const expected = c.env.OPENCLAW_GATEWAY_PASSWORD?.trim();
apps/engine-api/src/index.ts:136:      message: "OPENCLAW_GATEWAY_PASSWORD is not configured",
apps/agent-dashboard/src/lib/api.ts:108:    next.set("x-openclaw-gateway-password", GATEWAY_PASSWORD);
apps/agent-dashboard/src/hooks/useTradingSocket.ts:38:    base.searchParams.set("gateway_password", GATEWAY_PASSWORD);
apps/engine-api/src/env.d.ts:5:  OPENCLAW_GATEWAY_PASSWORD: string;
apps/engine-api/tests/tradingroom.integration.test.ts:5:const gatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
apps/engine-api/tests/tradingroom.integration.test.ts:17:    headers.set("x-openclaw-gateway-password", gatewayPassword);
apps/engine-api/tests/tradingroom.integration.test.ts:105:      wsUrl.searchParams.set("gateway_password", gatewayPassword);

exit_code=0
```

## Emergency Stop Coverage Scan

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ rg\ -n\ \'emergency-stop\|performEmergencyStop\|/stop\'\ apps/engine-api/src\ \|\|\ true 
```

```text
apps/engine-api/src/index.ts:228:app.post("/api/room/:id/emergency-stop", async (c) => {
apps/engine-api/src/index.ts:234:    new Request("https://internal/emergency-stop", { method: "POST" }),
apps/engine-api/src/index.ts:322:app.post("/api/room/:roomId/bot/:id/stop", async (c) => {
apps/engine-api/src/index.ts:329:  url.pathname = `/api/bot/${botId}/stop`;
apps/engine-api/src/index.ts:427:app.post("/api/bot/:id/stop", async (c) => {
apps/engine-api/src/index.ts:432:  url.pathname = `/api/bot/${botId}/stop`;
apps/engine-api/src/durable-objects/TradingRoom.ts:246:    // POST /emergency-stop - emergency shutdown
apps/engine-api/src/durable-objects/TradingRoom.ts:247:    if (request.method === "POST" && path.endsWith("/emergency-stop")) {
apps/engine-api/src/durable-objects/TradingRoom.ts:440:    const stopSummary = await this.performEmergencyStop("MANUAL_EMERGENCY_STOP");
apps/engine-api/src/durable-objects/TradingRoom.ts:449:    await this.performEmergencyStop("ROOM_RISK_BREACH");
apps/engine-api/src/durable-objects/TradingRoom.ts:452:  private async performEmergencyStop(reason: string): Promise<{
apps/engine-api/src/durable-objects/TradingRoom.ts:481:              `https://internal/api/bot/${encodeURIComponent(entry.agentId)}/stop`,
apps/engine-api/src/durable-objects/BotInstance.ts:352:    if (request.method === "POST" && path.endsWith("/stop")) {
apps/engine-api/src/durable-objects/BotInstance.ts:1065:  /** Push full state to TradingRoom (used on start/stop) */

exit_code=0
```

## Skill Checklist Snapshot

```bash
bash -lc cd\ \'/Users/ogarcia/projects/ogarciarevett/openclaw/openclaw-village\'\ \&\&\ cat\ skills/tradingroom-sdd-audit/references/checklist.md 
```

```text
# TradingRoom SDD Audit Checklist

## 1. Spec-vs-Code Parity

- [ ] TradingRoom concepts in spec map to concrete runtime files and endpoints.
- [ ] Acceptance criteria in spec are either implemented or explicitly documented as pending.
- [ ] Architecture naming is current (`TradingRoom`, `agent-dashboard`) with no stale primary references.

## 2. WS Contract Parity

- [ ] `packages/types/src/realtime.ts` includes all message types consumed by UI.
- [ ] Backend emits `FULL_STATE`, `STATE_DELTA`, `ROOM_STATE`, `PONG` and optional `TRADE_EVENT` with expected shapes.
- [ ] Dashboard message handler branches match backend message contracts.

## 3. Bot Identity Mapping

- [ ] Canonical `agentId` is stable and user-facing (slug) across API, DO, and UI.
- [ ] DO identifier (if present) is isolated as diagnostics (`doId`) and not used as UI primary key.
- [ ] Bot registration, room state cache, and dashboard cards map the same key.

## 4. Auth Coverage

- [ ] API routes enforce shared-secret auth.
- [ ] WS upgrade path enforces auth.
- [ ] Frontend REST and WS clients include auth credentials.
- [ ] Env typing includes required auth variable(s).

## 5. Build/Test Script Health

- [ ] Root scripts (`test`, `lint`, `start`) run without broken placeholder flags.
- [ ] Engine package includes runnable tests for risk/strategy/indicators.
- [ ] Integration path exists for TradingRoom WS + emergency-stop behavior.

## 6. Docs Drift

- [ ] `README.md` and specs reflect current package/app names.
- [ ] QA report statements match actual command outcomes.
- [ ] Security docs reflect current auth requirement.

exit_code=0
```

