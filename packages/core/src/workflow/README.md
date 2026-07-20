# Workflow Engine

This implements simple, in process workflow engine.

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
