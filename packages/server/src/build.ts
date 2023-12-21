import { build as esbuild } from 'esbuild';
import { parse } from 'es-module-lexer';
import { relative } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const clientComponentMap = {};

/**
 * Build both server and client components with esbuild
 */
export async function build() {
	const clientEntryPoints = new Set();

	/** Build the server component tree */
	await esbuild({
		bundle: true,
		format: 'esm',
		logLevel: 'error',
		entryPoints: [resolveApp('Page.tsx')],
		outdir: resolveBuild(),
		// avoid bundling npm packages for server-side components
		packages: 'external',
		plugins: [
			{
				name: 'resolve-client-imports',
				setup(build) {
					// Intercept component imports to check for 'use client'
					build.onResolve({ filter: reactComponentRegex }, async ({ path: relativePath }) => {
						const path = resolveApp(relativePath);
						const contents = await readFile(path, 'utf-8');

						if (contents.startsWith("'use client'")) {
							clientEntryPoints.add(path);
							return {
								// Avoid bundling client components into the server build.
								external: true,
								// Resolve the client import to the built `.js` file
								// created by the client `esbuild` process below.
								path: relativePath.replace(reactComponentRegex, '.js')
							};
						}
					});
				}
			}
		]
	});

	/** Build client components */
	// @ts-expect-error
	const { outputFiles, errors } = await esbuild({
		bundle: true,
		format: 'esm',
		logLevel: 'error',
		entryPoints: [resolveApp('_client.ts'), ...clientEntryPoints],
		outdir: resolveBuild(),
		splitting: true,
		write: false
	});

	if (errors.length > 0) {
		console.error(errors);
		return;
	}

	outputFiles!.forEach(async (file) => {
		// Parse file export names
		const [, exports] = parse(file.text);
		let newContents = file.text;

		for (const exp of exports) {
			// Create a unique lookup key for each exported component.
			// Could be any identifier!
			// We'll choose the file path + export name for simplicity.
			const key = file.path + exp.n;

			clientComponentMap[key] = {
				// Have the browser import your component from your server
				// at `/build/[component].js`
				id: `/build/${relative(resolveBuild(), file.path)}`,
				// Use the detected export name
				name: exp.n,
				// Turn off chunks. This is webpack-specific
				chunks: [],
				// Use an async import for the built resource in the browser
				async: true
			};

			// Tag each component export with a special `react.client.reference` type
			// and the map key to look up import information.
			// This tells your stream renderer to avoid rendering the
			// client component server-side. Instead, import the built component
			// client-side at `clientComponentMap[key].id`
			newContents += `
${exp.ln}.$$id = ${JSON.stringify(key)};
${exp.ln}.$$typeof = Symbol.for("react.client.reference");
			`;
		}
		await writeFile(file.path, newContents);
	});
}

/** UTILS */

const appDir = new URL('../../client/src/', import.meta.url);
const buildDir = new URL('./build/', import.meta.url);

function resolveApp(path = '') {
	return fileURLToPath(new URL(path, appDir));
}

function resolveBuild(path = '') {
	return fileURLToPath(new URL(path, buildDir));
}

const reactComponentRegex = /\.tsx$/;
