# ericodx.github.io

Software engineering notes, technical writing, projects, and professional experience.

Live at <https://ericodx.io>.

## Stack

- [Astro](https://astro.build/) — Blog template, TypeScript strict
- [Tailwind CSS](https://tailwindcss.com/) v4
- [Prettier](https://prettier.io/) with `prettier-plugin-astro`
- [pre-commit](https://pre-commit.com/) hooks (Conventional Commits, gitleaks, codespell, line endings, secrets, large files)
- Hosted on [GitHub Pages](https://pages.github.com/), deployed via GitHub Actions

## Development

Requires Node 24 (see `.nvmrc`).

```sh
nvm use
npm install
npm run dev      # dev server with HMR at http://localhost:4321
npm run build    # production build into dist/
npm run preview  # serve the production build locally
```

Install pre-commit hooks once:

```sh
brew install pre-commit
pre-commit install
```

## Workflow

Feature branches + PR. Direct commits to `main` are blocked by the `no-commit-to-branch` hook. Commits follow Conventional Commits format, single-line, no body, no `Co-Authored-By`.

## Content

Posts live in `src/content/blog/*.md` (or `.mdx`). Add `draft: true` in frontmatter to hide a post from production builds; it stays visible in `npm run dev`.

## Deploy

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds with `withastro/action@v3` and publishes via `actions/deploy-pages@v4`. Pages source must be set to **GitHub Actions** in the repository settings.

## License

Proprietary — see [LICENSE](./LICENSE). Source code and written content are © 2026 Érico Perez Neto. All rights reserved.
