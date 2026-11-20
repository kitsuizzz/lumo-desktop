#!/usr/bin/env node
/**
 * Fails when `webview/types/index.ts` and `webview/types/connector-contract.json` disagree.
 *
 * The JSON file is the wire contract for connector types crossing Tauri IPC. Rust asserts its
 * serialized output against the same file in `src-tauri/src/tools/contract.rs`, so a rename on
 * either side leaves the two checkers unable to agree. Run this with:
 *
 *     npm run check:contract
 *
 * `npm run typecheck` runs it too, and the pre-push hook runs `npm run typecheck`.
 */
import { readFileSync } from 'node:fs';

const contractUrl = new URL('../webview/types/connector-contract.json', import.meta.url);
const typesUrl = new URL('../webview/types/index.ts', import.meta.url);

const contract = JSON.parse(readFileSync(contractUrl, 'utf8'));
const source = readFileSync(typesUrl, 'utf8');

function fail(message) {
    throw new Error(message);
}

// Only the declaration subset used by webview/types/index.ts is parsed: type aliases whose
// bodies are object literals, tagged unions of object literals, string enums, references and
// arrays. Keeping the parser here avoids depending on TypeScript's internal AST, which the
// native TypeScript 7 package does not expose.
function tokenize(text) {
    const tokens = [];
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (/\s/.test(character)) {
            index += 1;
            continue;
        }
        if (character === '/' && text[index + 1] === '/') {
            index += 2;
            while (index < text.length && text[index] !== '\n') index += 1;
            continue;
        }
        if (character === '/' && text[index + 1] === '*') {
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
                index += 1;
            }
            index += 2;
            continue;
        }
        if (character === "'" || character === '"') {
            const quote = character;
            index += 1;
            let value = '';
            while (index < text.length && text[index] !== quote) {
                if (text[index] === '\\') {
                    value += text[index + 1];
                    index += 2;
                } else {
                    value += text[index];
                    index += 1;
                }
            }
            index += 1;
            tokens.push({ type: 'string', value });
            continue;
        }
        if (/[A-Za-z_$]/.test(character)) {
            const start = index;
            index += 1;
            while (index < text.length && /[A-Za-z0-9_$]/.test(text[index])) index += 1;
            tokens.push({ type: 'identifier', value: text.slice(start, index) });
            continue;
        }
        if (/[0-9]/.test(character)) {
            const start = index;
            index += 1;
            while (index < text.length && /[0-9.]/.test(text[index])) index += 1;
            tokens.push({ type: 'number', value: Number(text.slice(start, index)) });
            continue;
        }
        tokens.push({ type: 'punctuation', value: character });
        index += 1;
    }
    tokens.push({ type: 'eof', value: '' });
    return tokens;
}

class TypeParser {
    constructor(tokens) {
        this.tokens = tokens;
        this.position = 0;
    }

    peek(offset = 0) {
        return this.tokens[this.position + offset];
    }

    next() {
        const token = this.tokens[this.position];
        this.position += 1;
        return token;
    }

    eat(value) {
        const token = this.next();
        if (token.value !== value) {
            fail(`expected ${JSON.stringify(value)}, found ${JSON.stringify(token.value)}`);
        }
        return token;
    }

    eatIf(value) {
        if (this.peek().value === value) {
            this.next();
            return true;
        }
        return false;
    }

    parseFile(targets) {
        const aliases = new Map();
        while (this.peek().type !== 'eof') {
            if (
                this.peek().type === 'identifier' &&
                this.peek().value === 'type' &&
                this.peek(1).type === 'identifier' &&
                this.peek(2).value === '='
            ) {
                this.next();
                const name = this.next().value;
                this.eat('=');
                if (targets.has(name)) {
                    aliases.set(name, this.parseType());
                    this.eatIf(';');
                } else {
                    this.skipDeclaration();
                }
            } else {
                this.next();
            }
        }
        return aliases;
    }

    /** Skips an alias body this checker does not model, such as a function signature. */
    skipDeclaration() {
        let braces = 0;
        let brackets = 0;
        let parentheses = 0;
        while (this.peek().type !== 'eof') {
            const token = this.peek();
            if (token.value === '{') braces += 1;
            if (token.value === '}') braces -= 1;
            if (token.value === '[') brackets += 1;
            if (token.value === ']') brackets -= 1;
            if (token.value === '(') parentheses += 1;
            if (token.value === ')') parentheses -= 1;
            if (
                token.value === ';' &&
                braces === 0 &&
                brackets === 0 &&
                parentheses === 0
            ) {
                this.next();
                return;
            }
            this.next();
        }
    }

    parseType() {
        this.eatIf('|');
        const branches = [this.parsePrimary()];
        while (this.peek().value === '|') {
            this.next();
            branches.push(this.parsePrimary());
        }
        return branches.length === 1 ? branches[0] : { kind: 'union', branches };
    }

    parsePrimary() {
        let signature;
        const token = this.peek();
        if (token.value === '{') {
            signature = this.parseObject();
        } else if (token.type === 'string') {
            this.next();
            signature = { kind: 'literal', value: token.value };
        } else if (token.value === '(') {
            this.next();
            signature = this.parseType();
            this.eat(')');
        } else if (token.type === 'identifier') {
            this.next();
            if (token.value === 'string' || token.value === 'boolean' || token.value === 'number') {
                signature = { kind: 'scalar', name: token.value };
            } else if (token.value === 'any' || token.value === 'unknown') {
                signature = { kind: 'any' };
            } else if (token.value === 'null') {
                signature = { kind: 'null' };
            } else if (token.value === 'undefined') {
                signature = { kind: 'undefined' };
            } else if (token.value === 'true' || token.value === 'false') {
                signature = { kind: 'literal', value: token.value };
            } else if (this.peek().value === '<') {
                this.next();
                const first = this.parseType();
                while (this.eatIf(',')) this.parseType();
                this.eat('>');
                signature =
                    token.value === 'Array' || token.value === 'ReadonlyArray'
                        ? { kind: 'array', item: first }
                        : { kind: 'ref', name: token.value };
            } else {
                signature = { kind: 'ref', name: token.value };
            }
        } else {
            this.next();
            signature = { kind: 'unsupported', text: String(token.value) };
        }
        while (this.peek().value === '[' && this.peek(1).value === ']') {
            this.next();
            this.next();
            signature = { kind: 'array', item: signature };
        }
        return signature;
    }

    parseObject() {
        this.eat('{');
        const properties = new Map();
        let index = null;
        while (this.peek().value !== '}' && this.peek().type !== 'eof') {
            if (this.peek().value === '[') {
                this.next();
                this.next();
                this.eat(':');
                this.parseType();
                this.eat(']');
                this.eat(':');
                index = this.parseType();
            } else {
                const name = this.next().value;
                const optional = this.eatIf('?');
                this.eat(':');
                properties.set(name, { optional, sig: this.parseType() });
            }
            if (this.peek().value === ';' || this.peek().value === ',') this.next();
        }
        this.eat('}');
        return { kind: 'object', properties, index };
    }
}

function schemaShape(schema, where) {
    switch (schema.kind) {
        case 'any':
            return { kind: 'any' };
        case 'scalar':
            return { kind: 'scalar', name: schema.type };
        case 'ref':
            return { kind: 'ref', name: schema.ref };
        case 'array':
            return { kind: 'array', item: schemaShape(schema.items, where) };
        case 'map':
            return {
                kind: 'object',
                properties: new Map(),
                index: schemaShape(schema.values, where),
            };
        case 'string_enum':
            return { kind: 'literals', values: schema.values };
        case 'object': {
            const properties = new Map();
            for (const [name, field] of Object.entries(schema.fields)) {
                properties.set(name, {
                    optional: Boolean(field.optional),
                    sig: schemaShape(field, `${where}.${name}`),
                });
            }
            return { kind: 'object', properties, index: null };
        }
        case 'tagged_union': {
            if (schema.ts_style === 'open_tagged') {
                return {
                    kind: 'open_tagged',
                    tag: schema.tag,
                    tags: Object.keys(schema.variants),
                };
            }
            return {
                kind: 'variants',
                tag: schema.tag,
                variants: Object.entries(schema.variants).map(([tagValue, fields]) => {
                    const properties = new Map();
                    properties.set(schema.tag, {
                        optional: false,
                        sig: { kind: 'literal', value: tagValue },
                    });
                    for (const [name, field] of Object.entries(fields)) {
                        properties.set(name, {
                            optional: Boolean(field.optional),
                            sig: schemaShape(field, `${where}.${tagValue}.${name}`),
                        });
                    }
                    return {
                        tagValue,
                        sig: { kind: 'object', properties, index: null },
                    };
                }),
            };
        }
        default:
            return fail(`${where}: unknown contract kind ${JSON.stringify(schema.kind)}`);
    }
}

function dropNullish(signature) {
    if (signature.kind === 'null' || signature.kind === 'undefined') return { kind: 'never' };
    if (signature.kind !== 'union') return signature;
    const branches = signature.branches
        .map(dropNullish)
        .filter((branch) => branch.kind !== 'never');
    if (branches.length === 1) return branches[0];
    return { kind: 'union', branches };
}

function literalValues(signature) {
    if (signature.kind === 'literal') return [signature.value];
    if (signature.kind !== 'union') return null;
    const values = [];
    for (const branch of signature.branches) {
        const branchValues = literalValues(branch);
        if (!branchValues) return null;
        values.push(...branchValues);
    }
    return values;
}

function sorted(values) {
    return [...values].sort();
}

function expectSameSet(expected, actual, where) {
    const left = sorted(expected);
    const right = sorted(actual);
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
        fail(`${where}: expected ${left.join(' | ')}, found ${right.join(' | ')}`);
    }
}

function tagValue(branch, tag) {
    if (branch.kind !== 'object') return null;
    const property = branch.properties.get(tag);
    if (!property || property.sig.kind !== 'literal') return null;
    return property.sig.value;
}

function label(signature) {
    switch (signature.kind) {
        case 'scalar':
            return signature.name;
        case 'literal':
            return JSON.stringify(signature.value);
        case 'ref':
            return signature.name;
        case 'array':
            return `${label(signature.item)}[]`;
        case 'any':
            return 'unknown';
        case 'object':
            return 'object';
        case 'literals':
            return signature.values.join(' | ');
        default:
            return signature.kind;
    }
}

function match(expected, actual, where, extraFields = new Set()) {
    actual = dropNullish(actual);

    if (expected.kind === 'any') return;
    if (actual.kind === 'never') fail(`${where}: TypeScript type is only null or undefined`);
    if (actual.kind === 'any') {
        fail(`${where}: TypeScript type is any/unknown, expected ${label(expected)}`);
    }
    if (actual.kind === 'unsupported') {
        fail(`${where}: unsupported TypeScript type ${JSON.stringify(actual.text)}`);
    }

    switch (expected.kind) {
        case 'literals': {
            const values = literalValues(actual);
            if (!values) fail(`${where}: expected ${expected.values.join(' | ')}`);
            expectSameSet(expected.values, values, where);
            return;
        }
        case 'variants': {
            const branches = actual.kind === 'union' ? actual.branches : [actual];
            const cleaned = branches.map(dropNullish).filter((branch) => branch.kind !== 'never');
            if (cleaned.length !== expected.variants.length) {
                fail(
                    `${where}: expected ${expected.variants.length} variants ` +
                        `(${expected.variants.map((variant) => variant.tagValue).join(', ')}), ` +
                        `found ${cleaned.length}`,
                );
            }
            for (const variant of expected.variants) {
                const branch = cleaned.find(
                    (candidate) => tagValue(candidate, expected.tag) === variant.tagValue,
                );
                if (!branch) fail(`${where}: missing variant ${variant.tagValue}`);
                match(variant.sig, branch, `${where}.${variant.tagValue}`, new Set());
            }
            return;
        }
        case 'open_tagged': {
            if (actual.kind !== 'object') {
                fail(`${where}: expected an object tagged on ${expected.tag}`);
            }
            const tag = actual.properties.get(expected.tag);
            if (!tag) fail(`${where}: missing ${expected.tag} property`);
            const values = literalValues(tag.sig);
            if (!values) fail(`${where}: ${expected.tag} must be a string literal union`);
            expectSameSet(expected.tags, values, `${where}.${expected.tag}`);
            if (!actual.index || actual.index.kind !== 'any') {
                fail(`${where}: expected an index signature for the unmodelled variant fields`);
            }
            return;
        }
        case 'scalar': {
            if (actual.kind === 'scalar') {
                if (actual.name !== expected.name) {
                    fail(`${where}: expected ${expected.name}, found ${actual.name}`);
                }
                return;
            }
            const values = literalValues(actual);
            if (!values) fail(`${where}: expected ${expected.name}`);
            for (const value of values) {
                const ok =
                    (expected.name === 'string' && typeof value === 'string') ||
                    (expected.name === 'boolean' && (value === 'true' || value === 'false')) ||
                    (expected.name === 'number' && typeof value === 'number');
                if (!ok) fail(`${where}: expected ${expected.name}, found ${JSON.stringify(value)}`);
            }
            return;
        }
        case 'literal': {
            if (actual.kind !== 'literal' || actual.value !== expected.value) {
                fail(`${where}: expected literal ${JSON.stringify(expected.value)}`);
            }
            return;
        }
        case 'ref': {
            if (actual.kind !== 'ref' || actual.name !== expected.name) {
                fail(`${where}: expected ${expected.name}, found ${label(actual)}`);
            }
            return;
        }
        case 'array': {
            if (actual.kind !== 'array') fail(`${where}: expected ${label(expected)}`);
            match(expected.item, actual.item, `${where}[]`, new Set());
            return;
        }
        case 'object': {
            if (actual.kind !== 'object') {
                fail(`${where}: expected an object, found ${label(actual)}`);
            }
            for (const [name, property] of expected.properties) {
                const found = actual.properties.get(name);
                if (!found) {
                    if (property.optional) continue;
                    fail(`${where}: missing field ${name}`);
                }
                match(property.sig, found.sig, `${where}.${name}`, new Set());
            }
            if (expected.index) {
                if (!actual.index) fail(`${where}: missing index signature`);
                match(expected.index, actual.index, `${where}[key]`, new Set());
            } else if (actual.index) {
                fail(`${where}: unexpected index signature`);
            }
            for (const name of actual.properties.keys()) {
                if (!expected.properties.has(name) && !extraFields.has(name)) {
                    fail(`${where}: unexpected field ${name}`);
                }
            }
            return;
        }
        default:
            fail(`${where}: unknown expectation ${expected.kind}`);
    }
}

function validateReferences() {
    const visit = (schema, where) => {
        if (schema.kind === 'ref' && !contract.types[schema.ref]) {
            fail(`${where}: unresolved contract reference ${schema.ref}`);
        }
        for (const key of ['items', 'values']) {
            if (schema[key]) visit(schema[key], where);
        }
        for (const field of Object.values(schema.fields ?? {})) visit(field, where);
        for (const fields of Object.values(schema.variants ?? {})) {
            for (const field of Object.values(fields)) visit(field, where);
        }
    };
    for (const [name, schema] of Object.entries(contract.types)) visit(schema, name);
}

const targets = new Set(
    Object.values(contract.types)
        .filter((schema) => schema.ts)
        .map((schema) => schema.ts.name),
);
const aliases = new TypeParser(tokenize(source)).parseFile(targets);
const failures = [];
let checked = 0;

validateReferences();

for (const [name, schema] of Object.entries(contract.types)) {
    if (!schema.ts) continue;
    const mirror = aliases.get(schema.ts.name);
    if (!mirror) {
        failures.push(`${schema.ts.name}: missing TypeScript declaration for contract type ${name}`);
        continue;
    }
    try {
        const extra = new Set(schema.ts.extra_fields ?? []);
        match(schemaShape(schema, name), mirror, schema.ts.name, extra);
        checked += 1;
    } catch (error) {
        failures.push(error.message);
    }
}

if (failures.length > 0) {
    console.error('Connector contract check failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
        '\nUpdate webview/types/index.ts and webview/types/connector-contract.json together.',
    );
    process.exit(1);
}

console.log(`Connector contract: ${checked} TypeScript declarations match connector-contract.json`);