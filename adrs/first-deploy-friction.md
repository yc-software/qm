# Notes from a first deploy, from a PM who is not an engineer

I spent an evening trying to get QM running locally, docker target, following your docs as written. I'm a project manager evaluating this for a small team, not a developer, which probably makes me a decent crash test dummy for the first hour. Sharing where I got stuck in case it helps.

First, the good part. `qm init` is the smoothest scaffold I've ever run. One command, no questions asked, every file it wrote got explained, signing keys were already generated, and it printed a clear list of next steps. The comments in `.env.example` are honestly better than most paid products manage. Whoever wrote those, thank you.

Now the sticking points, in the order I hit them.

The next steps that init prints say check, then up. But when I ran `qm check` it warned me that no sandbox image was pinned and that I should run `qm sandbox publish` first. So the first time I learned that step existed was from a warning. Small thing, but it broke my trust in the checklist right at the start.

Then the wall. `qm sandbox publish` on the docker target asked me for a Fly token. I had picked docker precisely because I wanted to try QM on my laptop before signing up for anything. Turns out a local deploy still needs a Fly account for the agent computers. Maybe that's a deliberate design choice, and that's fine, but I only found out three commands deep. If it's intended, say it in the README and in the init output for the docker target, right up front. And if some limited local only mode is possible, even a mock one just to feel the product, I think that's the single highest value improvement to the first hour.

Two smaller ones. `PUBLIC_API_URL` is required but comes blank, and I couldn't figure out what a docker deploy wants there. The config already knows my publicUrl, so could init prefill it, or the comment show the expected local value? And `qm check` told me "check passed" while my required secrets were still empty. I get that check is static, but the green tick made me think I was further along than I was. A line listing which required secrets are still blank would set honest expectations.

That's it. The product looks like exactly what small teams need, which is why the first hour matters so much. Happy to rerun this on a future version and time it properly.
