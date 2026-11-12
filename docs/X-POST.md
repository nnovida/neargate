# X post draft

The event asks for a public post on X that says the project was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, and carries the demo video (screenshots are not enough when judges cannot open the demo). The post's link and the repository link both go into the submission form.

Before posting, replace the two placeholders:

| Placeholder | Replace with |
|---|---|
| `REPO_URL` | the public repository URL |
| `VIDEO` | the demo video link, or delete the line and attach the video to the post itself (a non-Premium X account uploads at most 140 s; the script in [DEMO-VIDEO.md](DEMO-VIDEO.md) runs under 2 minutes) |

X counts every link as 23 characters, so the post below stays within 280 characters once both links are in. It is plain ASCII on purpose: X counts some other characters, such as emoji, as two. `e2e/readme.test.ts` checks the length and the tags.

```text
AI agents can't sign up for API keys. NearGate lets them pay per API call in NEAR, with on-chain seller scores and agent keys limited to a prepaid escrow. Feedback welcome!

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
REPO_URL
VIDEO
```
