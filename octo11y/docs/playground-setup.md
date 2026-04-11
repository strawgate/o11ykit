# Setting up a benchkit playground

This guide describes how to set up a **separate** repository for iterating on benchkit workflows, dashboards, or experiments without risking the stable demo or production automation.

## Why a playground?

Benchkit uses a **two-lane deployment model**:

- **Stable demo** ([`packages/dashboard`](../packages/dashboard/README.md)): deployed from release tags to GitHub Pages. The public documentation and showcase site point here. It must stay reliable.
- **Playground** (separate repo): a fast-iteration sandbox. Maintainers and contributors test new workflow features, experiment with custom dashboards, or prototype new data sources here without touching production `bench-data` automation.

This separation keeps:
- Public URLs reliable
- Release artifacts safe from in-flight edits
- Experimentation low-friction and consequence-free

## Setting up your playground

### 1. Create a new repository

```bash
gh repo create benchkit-playground --public
cd benchkit-playground
git init
```

### 2. Add dependencies

Create a `package.json`:

```json
{
  "name": "benchkit-playground",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc && vite build",
    "dev": "vite",
    "preview": "vite preview"
  },
  "dependencies": {
    "@benchkit/chart": "^0.1.1",
    "@benchkit/format": "^0.1.1",
    "@octo11y/core": "^0.1.1",
    "preact": "^10.25.0"
  },
  "devDependencies": {
    "@preact/preset-vite": "^2.9.0",
    "typescript": "^5.5.0",
    "vite": "^6.0.0"
  }
}
```

### 3. Create a minimal TypeScript config

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "resolveJsonModule": true,
    "moduleResolution": "bundler"
  }
}
```

### 4. Create a Vite config

`vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  base: '/benchkit-playground/',
});
```

### 5. Create a dashboard entry point

`src/main.tsx`:

```typescript
import { render } from 'preact';
import { Dashboard } from '@benchkit/chart';

// Replace with your own data source or benchkit repository
const repo = 'strawgate/octo11y'; // or your fork
const dataUrl = `https://raw.githubusercontent.com/${repo}/bench-data/index.json`;

render(
  <Dashboard
    indexUrl={dataUrl}
    title="Benchkit Playground"
    description="Experimental dashboard and workflow test environment"
  />,
  document.getElementById('app')!
);
```

`src/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Benchkit Playground</title>
  </head>
  <body style="margin: 0">
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### 6. Install and run

```bash
npm install
npm run dev
```

The playground dev server starts at `http://localhost:5173/benchkit-playground/`.

## Common playground tasks

### Testing a custom action locally

1. Clone or link the action from benchkit:

   ```bash
   ln -s ../benchkit/actions/stash ./actions/stash
   ```

2. Add a workflow in `.github/workflows/test-stash.yml` that tests your modifications.

### Testing a custom dashboard layout

1. Copy the dashboard component approach from [packages/dashboard/src/main.tsx](../packages/dashboard/src/main.tsx).
2. Import `Dashboard`, `RunDashboard`, or `RunDetail` from `@benchkit/chart`.
3. Modify props, data sources, or styling.
4. Deploy to your playground GitHub Pages.

### Using a custom data branch

Edit `src/main.tsx` to point at your fork or experiment branch:

```typescript
const repo = 'your-username/benchkit-fork';
const branch = 'experiments/my-workflow';
const dataUrl = `https://raw.githubusercontent.com/${repo}/${branch}/bench-data/index.json`;
```

## Deploying from the playground

### Local deployment

```bash
npm run build
npx gh-pages -d dist
```

### GitHub Actions deployment

Create `.github/workflows/pages.yml`:

```yaml
name: Deploy Playground

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
```

## Best practices

- **Keep iteration fast**: Don't worry about CI/CD complexity. Playground is for rapid exploration.
- **Share learnings**: If a workflow or dashboard pattern works well, consider contributing it back to benchkit.
- **Don't use production `bench-data`**: Create a separate branch for playground data to avoid polluting the main benchmark record.
- **Reference stable releases**: Always pin `@benchkit/*` and `@octo11y/*` versions to stable releases. Don't use `*` or `latest` in a playground.

## Next steps

- Read [`getting-started.md`](getting-started.md) for the full workflow and action tour.
- Explore [`reference/react-components.md`](reference/react-components.md) for component prop tables.
- Join discussions in benchkit issues for feedback and ideas.
