# The names people, git hooks and coding agents use. Each is one npm script from package.json,
# which is where the commands themselves are written, once; CI runs those same scripts.

# List the recipes
default:
    @just --list

# Build the protocol, the server, the agent, the inspector and the tlpt package
build:
    npm run build

# What must pass before a commit: types, ES5 syntax and built-ins, both size budgets
check:
    npm run check

# Unit and end-to-end tests
test:
    npm test

# build, check and test, as CI runs them
all: build check test

# tlpt-<version>.tgz in the repository root, to hand to someone: they run npm install -g ./tlpt-<version>.tgz
pack:
    npm run pack

# Remove everything a build writes: tsc never deletes the output of a source file that is gone
clean:
    rm -rf packages/*/dist packages/*/*.tsbuildinfo packages/tlpt/assets packages/tlpt/sea
