const [origin, commit] = process.argv.slice(2);
if (!origin || !commit) {
  throw new Error("Usage: node scripts/check-deployment.mjs <origin> <commit>");
}

// First-time DNS and TLS provisioning can take several minutes.
for (let attempt = 1; attempt <= 40; attempt++) {
  try {
    const metadata = await fetch(`${origin}/.well-known/deployment`, {
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    if (!metadata.ok || (await metadata.json()).commit !== commit) {
      throw new Error("Hostname is not serving the expected commit yet");
    }
    const page = await fetch(origin, { signal: AbortSignal.timeout(15000) });
    if (!page.ok || !(await page.text()).includes("<html")) {
      throw new Error(`App did not return HTML successfully: ${page.status}`);
    }
    console.log(`Verified ${origin} at ${commit}`);
    process.exit(0);
  } catch (error) {
    console.log(`Attempt ${attempt}/40: ${error.message}`);
  }
  if (attempt < 40) {
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
}
throw new Error(`Deployment verification failed for ${origin}`);
