# mend

One Node 22 CLI applies AI-generated edits to a file tree in unified diff, SEARCH/REPLACE, V4A, and JSON edit formats.

`SPEC.md` is the behavior contract. The CLI uses only Node's standard library and runs as:

```sh
node main.ts [options] [PATCH]
```

The public practice checks are in `check.ts`; `runner.ts` is the contest trial adapter.

## The files

- `main.ts`: the CLI for all four edit formats, safe paths, matching, reporting, and all-or-nothing writes.
- `runner.ts`: in a trial it reads the checks from the env, runs `node main.ts` on each one in a
  fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT. Your repository needs an OSI-approved licence of your choosing.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit
code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared,
so write what you like there. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and indentation, blank
context lines without their leading space, prose and code fences around the patch, CRLF files, files without a final
line break, blocks that occur twice. Read SPEC.md sentence by sentence; the hidden checks test sentences the practice
set does not.
