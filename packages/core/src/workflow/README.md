# Workflow Engine

This implements simple, in process workflow engine simillar to DBOS adapted to our own backends and append only logs.

Steps and Workflows are defined as such:

```ts
const step = defineStep(name, func)

const workflow = defineWorkflow(name, async (ctx) => {
  await ctx.step(step, input)
})
```
Both are wrappers that mark functions as steps for workflow itself and can be inlined

Engine is creates in process and gets passed the workflows:

```ts
const engine = createEngine({ db, workflows: [workflow] })
```

you can run individual workflows by `engine.start(workflow)`

Engine supports additional commands such as:
```ts
// start
const wf = engine.start(workflow)
// resume/retry the run
engine.resume(wf.runId)
// cancel the run
engine.cancel(wf.runId)
```


Both steps and workflows have maxAttempts parameter on how many times it should retry the step before it fails


We have following schema:
`workflow_runs` // store workflow run information
`workflow_events` // append only store storing events as they go, created run, started run, completed run, etc, etc
`workflow_steps` // store workflow step information
`workflow_stream_chunks` // store workflow stream chunks and read it


Workflows support streaming via workflow_stream_chunks

for now its designed to be in process wakers, streaming is done to stream ai responses.
Each chunk is stored in the dabase, notifies waker and waker reads db from the cursor it had
