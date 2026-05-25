# ericodx.github.io

Software engineering notes, technical writing, projects, and professional experience.

Live at <https://ericodx.io>.

## Stack

- [Astro](https://astro.build/) — Blog template, TypeScript strict
- [Prettier](https://prettier.io/) with `prettier-plugin-astro`
- [pre-commit](https://pre-commit.com/) hooks (Conventional Commits, gitleaks, codespell, line endings, secrets, large files)
- Hosted on [GitHub Pages](https://pages.github.com/), deployed via GitHub Actions

## Up and running

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
