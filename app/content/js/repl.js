/*
 * Copyright 2017-18 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


/**
 * The Read-Eval-Print Loop (REPL)
 *
 */

const debug = require('debug')('repl')
debug('loading')

const self = {},
      minimist = require('yargs-parser'),
      commandTree = require('./command-tree')

debug('finished loading modules')

// TODO clean up when repl becomes a module
let wsk, help, history


// this will go away shortly
const modules = {
    errors: {
        usage: require('./usage-error')
    },
    eventBus,
    ui,
    namespace,
    wsk,
    repl: self
}

/**
 * Make sure that the given repl block is visible.
 *
 * @param when wait this long; e.g. the 305ms is in step with the sidecar transition: all 300ms ease-in-out
 * @param which the repl block sub-element that needs to be visible
 * @param center this is passed directly to the underlying API https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoViewIfNeeded
 *
 */
self.scrollIntoView = ({ when=305, which='.repl-active', center=true }={}) => setTimeout(() => {
    try {
        // false here means "bottom of the element will be aligned to the bottom of the visible area of the scrollable ancestor"
        //    (see https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoView)
        //document.querySelector('#main-repl .repl-active').scrollIntoView(true)
        document.querySelector(`#main-repl ${which}`).scrollIntoViewIfNeeded(center)
    } catch (e) {}
}, when)

const formatOneListResult = options => (entity, idx, A) => {
    const dom = document.createElement('div')
    dom.className = `entity ${entity.prettyType || ''} ${entity.type}`
    dom.setAttribute('data-name', entity.name)

    if (entity.packageName) {
        dom.setAttribute('data-package-name', entity.packageName)
    }

    const entityName = document.createElement('div')
    entityName.className = 'entity-attributes'
    dom.appendChild(entityName)

    // add any badges
    /*const prefix = document.createElement('span')
    prefix.className = 'repl-result-prefix'
    entityName.appendChild(prefix)

    const prettyType = document.createElement('span')
    prettyType.className = 'openwhisk-pretty-type'
    prettyType.innerText = entity.prettyType || wsk.toOpenWhiskKind(entity.type)
    prefix.appendChild(prettyType)*/

    /** add a cell to the current row of the list view we] are generating. "entityName" is the current row */
    const addCell = (className, value, innerClassName='', parent=entityName, onclick, watch, key, fontawesome) => {
        const cell = document.createElement('span'),
              inner = document.createElement('span')

        cell.className = className
        inner.className = innerClassName
        inner.classList.add('cell-inner')

        if (key) {
            inner.setAttribute('data-key', key)
        }

        if (fontawesome) {
            const icon = document.createElement('i')
            inner.appendChild(icon)
            icon.className = fontawesome
            inner.setAttribute('data-value', value) // in case tests need the actual value, not the icon

        } else if (value) {
            Promise.resolve(value)
                .then(value => inner.appendChild(value.nodeName ? value : document.createTextNode(value.toString())))
        } else {
            console.error('Invalid cell model, no value field')
        }
        cell.appendChild(inner)
        parent.appendChild(cell)

        if (onclick) {
            cell.classList.add('clickable')
            cell.onclick = evt => {
                evt.stopPropagation() // don't trickle up to the row click handler
                onclick(evt)
            }
        }

        if (watch) {
            const spinner = document.createElement('i')
            spinner.className = 'fas fa-spinner fa-pulse small-left-pad deemphasize'
            cell.appendChild(spinner)

            const interval = setInterval(() => {
                try {
                    Promise.resolve(watch())
                        .then(({ value, done=false, css, others=[], unchanged=false }) => {
                            if (unchanged) {
                                // nothing to do, yet
                                return
                            }

                            // are we done polling for updates?
                            if (!value || done) {
                                clearInterval(interval)

                                const toRemove = cell.querySelector('.fa-spinner')
                                cell.removeChild(toRemove)
                            }

                            // update the styling
                            if (css) {
                                inner.className = css
                            }

                            // update the text
                            if (value) {
                                inner.innerText = ''
                                inner.appendChild(value.nodeName ? value : document.createTextNode(value.toString()))
                            }

                            // any other cells to update?
                            others.forEach(({key, value}) => {
                                const otherInner = parent.querySelector(`.cell-inner[data-key="${key}"]`)
                                if (otherInner) {
                                    otherInner.innerText = ''
                                    otherInner.appendChild(value.nodeName ? value : document.createTextNode(value.toString()))
                                }
                            })
                        })

                } catch (err) {
                    console.error('Error watching value', err)
                    clearInterval(interval)

                    const toRemove = cell.querySelector('.fa-spinner')
                    cell.removeChild(toRemove)
                }

            }, 2000)
        }

        return cell
    }

    // add any attributes that should appear *before* the name column
    if (entity.beforeAttributes) {
        entity.beforeAttributes.forEach(({key, value, css='', outerCSS='', onclick, fontawesome}) => addCell(outerCSS, value, css, undefined, onclick, undefined, key, fontawesome))
    }

    // now add the clickable name
    const entityNameGroup = document.createElement('span')
    entityNameGroup.className = 'entity-name-group'
    if ((!options || !options.excludePackageName) && entity.packageName) {
        const packagePrefix = document.createElement('span')
        packagePrefix.className = 'package-prefix'
        packagePrefix.innerText = entity.packageName + '/'
        entityNameGroup.appendChild(packagePrefix)
    }
    const entityNameClickable = document.createElement('span')
    entityNameClickable.className = 'clickable entity-name'
    entityNameGroup.appendChild(entityNameClickable)
    entityName.appendChild(entityNameGroup)

    // name of the entity
    let name = entity.prettyName || entity.name

    // click handler for the list result
    if (typeof name === 'string') {
        entityNameClickable.innerText = name
    } else {
        entityNameClickable.appendChild(name)
    }
    if (entity.fullName) {
        entityNameClickable.setAttribute('title', entity.fullName)
    }

    if (entity.onclick === false) {
        // the provider has told us the entity name is not clickable
        entityNameClickable.classList.remove('clickable')
    } else {
        dom.onclick = entityNameClickable.onclick = entity.onclick
            || (() => self.pexec(`wsk ${entity.type} get "/${entity.namespace}/${entity.name}"`))
    }

    const addKind = kind => addCell('entity-kind green-text', kind, 'deemphasize deemphasize-partial')
    const addVersion = () => entity.version && addCell('entity-version', entity.version, 'deemphasize')

    //
    // case-specific cells
    //
    if (entity.attributes) {
        entity.attributes.forEach(({key, value, css='', outerCSS='', watch, onclick, fontawesome}) => addCell(outerCSS, value, css, undefined, onclick, watch, key, fontawesome))

    } else if (entity.type === 'actions') {
        // action-specific cells
        const kind = entity.annotations.find(({key}) => key === 'exec')
        if (kind || entity.prettyKind) {
            addKind(entity.prettyKind || kind.value)
        }

        if (entity.prettyType === 'sequence') {
            setTimeout(() => {
                repl.qexec(`wsk action get "/${entity.namespace}/${entity.name}"`)
                    .then(action => {
                        if (action.exec && action.exec.components) {
                            const ns = new RegExp('^/' + namespace.current() + '/')
                            addCell('entity-sequence-components',
                                    action.exec.components
                                    .map(_ => _.replace(ns, ''))
                                    .join(' \u27f6 ')) // ->
                            
                        } else {
                            addVersion()
                        }
                    })
        }, 0)

        } else {
            addVersion()
        }
    } else if (entity.type === 'rules') {
        // rule-specific cells
        setTimeout(() => {
            repl.qexec(`wsk rule get "/${entity.namespace}/${entity.name}"`)
                .then(rule => {
                    addCell(`entity-rule-status ${rule.status==='active' ? 'green-text' : 'red-text'}`, rule.status, 'deemphasize deemphasize-partial')
                    addCell('entity-rule-definition', `${rule.trigger.name} \u27fc ${rule.action.name}`)
                })
        }, 0)
    } else if (entity.type) {
        addKind(entity.prettyType || entity.type.replace(/s$/, ''))
        addVersion()
    }

    return dom
}
self.formatOneListResult = formatOneListResult

/** render the results of a command evaluation in the "console" */
const printResults = (block, nextBlock, resultDom, echo=true, execOptions, parsedOptions) => response => {
    //debug('repl::printResults', response)
    if (echo) ui.setStatus(block, 'valid-response')

    const render = response => {
    if (response && response !== true) {
        if (response.map) {
            //
            // some sort of list response; format as a table
            //

            if (response[0] && response[0].activationId) {
                //
                // oh, we do some special formatting for activation list
                //
                const activationIds = response,
                      container = resultDom
                require('./views/list/activations').render({activationIds, container,
                                                            parsedOptions,
                                                            skip: parsedOptions.skip || 0,
                                                            limit: parsedOptions.limit || activationIds.length,
                                                            noPip: true, showResult: false, showStart: true,
                                                            showTimeline: !parsedOptions || !parsedOptions.simple })
                if (activationIds.length > 0) {
                    resultDom.parentNode.classList.add('result-table')
                    resultDom.parentNode.classList.add('result-table-full-width')
                }
                resultDom.parentNode.classList.add('result-vertical')
                if (echo) ui.ok(resultDom.parentNode).className = 'ok-for-list'
                return // done!
            }

            if (response.length > 0) {
                // sort the list, then format each element, then add the results to the resultDom
                // (don't sort lists of activations. i wish there were a better way to do this)
                const sort = () => {
                    if (response[0] && response[0].noSort) {
                        return response
                    } else {
                        return response.sort((a,b) =>
                                             (a.prettyType || a.type).localeCompare(b.prettyType || b.type)
                                             || (a.packageName || '').localeCompare(b.packageName || '')
                                             || a.name.localeCompare(b.name))
                    }
                }

                sort().map(formatOneListResult())
                    .map(dom => resultDom.appendChild(dom))

                // decorate it as a table
                resultDom.parentNode.classList.add('result-table')
            }

            // say "ok"
            resultDom.parentNode.classList.add('result-vertical')
            if (echo) ui.ok(resultDom.parentNode).className = 'ok-for-list'

        } else if (response.nodeName) { // TODO is this the best way to detect response is a dom??
            // pre-formatted DOM element
            if (echo) {
                resultDom.appendChild(response)
                resultDom.parentNode.classList.add('result-vertical')
                ui.ok(resultDom.parentNode).className = 'ok-for-list'
            }

        } else if (response.verb === 'list' && response[response.type] && typeof response[response.type] === 'number') {
            // maybe a list API returned a count?
            const span = document.createElement('span')
            span.innerText = response[response.type]
            resultDom.appendChild(span)
            resultDom.parentNode.classList.add('result-vertical')
            ui.ok(resultDom.parentNode).className = 'ok-for-list'

        } else if (typeof response === 'number' || typeof response === 'string' || (!response.type && response.message && typeof response.message === 'string')) {
            // if either the response is a string, or it's a non-entity (no response.type) and has a message field
            //     then treat the response as a simple string response
            if (echo) {
                // wrap in a span so that drag text selection works; see shell issue #249
                const span = document.createElement('span')
                span.innerText = response.message || response
                resultDom.appendChild(span)
                resultDom.parentNode.classList.add('result-vertical')
                ui.ok(resultDom.parentNode).className = 'ok-for-list'
            }

        } else if (response.type === 'custom' || response.renderAs == 'custom') {
            if (echo) {
                ui.showCustom(response, execOptions)
                ui.ok(resultDom.parentNode)
            } else if (execOptions && execOptions.replSilence) {
                ui.showCustom(response, execOptions)
            }

        } else if (response.type === 'activations') {
            // activation response
            ui.showActivation(response, resultDom, execOptions)

        } else if (response.verb === 'delete') {
            if (echo) ui.ok(resultDom.parentNode)

        } else if (response.verb === 'get' || response.verb === 'create' || response.verb === 'update') {
            // get response?
            const forRepl = ui.showEntity(response, Object.assign({}, execOptions||{}, {echo, show: response.show || 'default'}))
            // forRepl means: the sidecar wants to display something on the repl when it's done
            // it's either a promise or a DOM entry directly
            if (echo) {
                if (forRepl && forRepl.then) {
                    forRepl.then(render)
                } else if (forRepl) {
                    ui.ok(resultDom.parentNode)
                }
            }

        } else if (typeof response === 'object') {
            // render random json
            const code = document.createElement('code')
            code.appendChild(document.createTextNode(JSON.stringify(response, undefined, 4)))
            resultDom.appendChild(code)
            setTimeout(() => hljs.highlightBlock(code), 0)
            resultDom.parentNode.classList.add('result-vertical')
            ui.ok(resultDom.parentNode).className = 'ok-for-list'
        }
    } else if (response) {
        if (echo) ui.ok(resultDom.parentNode)
    }
    }

    render(response)
    return Promise.resolve()
}

const listenForRemoteExecs = () => {
    const { ipcRenderer } = require('electron')
    ipcRenderer.on('/repl/pexec', (event, {command}) => {
        debug('remote pexec', command)
        return repl.pexec(command)
    })
}

self.init = (prefs={}) => {
    debug('init')
    ui.listen(ui.getInitialPrompt())

    listenForRemoteExecs()

    // TODO clean up when repl becomes a module
    wsk = plugins.require('/ui/commands/openwhisk-core')
    help = plugins.require('/ui/commands/help')
    history = plugins.require('/ui/commands/history')

    if (!prefs.noAuthOk && !wsk.auth.get()) {
        self.setNoAuth()
    }

    // focus the current prompt no matter where the user clicks
    document.querySelector('#main-repl').onclick = evt => {
        if (!window.getSelection().toString()) {
            // if there is no selected text, then focus
            // this works, because the HTML (? or chrome?) section model behavior is to clear the selection upon click
            // so we only need to protect against mouseups due to the user dragging out a new selection
            // see github issue #8
            ui.getCurrentPrompt().focus()
        }
    }

    // we don't want the prompt to lose focus when the user drags when
    // window around (which is initiated by clicking on the header)
    document.querySelector('.page > header').onclick = evt => {
        ui.getCurrentPrompt().focus()
    }
    
    /** listen for paste events, focus on the current prompt first */
    document.body.onpaste = evt => {
        ui.getCurrentPrompt().focus()
    }
}

/**
 * User hit enter in the REPL
 *
 */
self.eval = () => {
    const block = ui.getCurrentBlock(),
          prompt = ui.getPrompt(block),
          command = prompt.value.trim()

    if (block.completion) {
        // then this is a follow-up to self.prompt
        block.completion(prompt.value)
    } else {
        // otherwise, this is a plain old eval, resulting from the user hitting Enter
        return self.exec(command)
    }
}

/** prompt the user for information */
self.prompt = (msg, block, nextBlock, options, completion) => {
    debug('prompt')

    const ctx = block.querySelector('.repl-context'),
          selection = block.querySelector('.repl-selection'),
          prompt = ui.getPrompt(block),
          resultDom = block.querySelector('.repl-result')

    const currentContext = ctx.innerText,
          currentSelection = selection.innerText,
          currentType = prompt.getAttribute('type'),
          currentInput = prompt.value,
          currentPlaceholder = prompt.getAttribute('placeholder')

    // reactivate the current prompt
    ui.listen(prompt)
    block.className = `${block.getAttribute('data-base-class')} repl-active`

    ctx.innerText = msg
    selection.innerText = ''   // no selection for prompts (for now?)
    prompt.readOnly = false
    prompt.value = ''
    prompt.setAttribute('placeholder', options.placeholder || `Enter your ${msg}`)

    if (options.type) {
        prompt.setAttribute('type', options.type)
    }

    const restorePrompt = err => {
        ui.setStatus(block, 'valid-response')
        ctx.innerText = currentContext
        selection.innerText = currentSelection
        prompt.value = currentInput
        prompt.setAttribute('type', currentType)
        prompt.setAttribute('placeholder', currentPlaceholder)
    }
    
    block.completion = value => {
        block.className = `${block.getAttribute('data-base-class')} processing`
        ui.unlisten(prompt)
        prompt.readOnly = true
        return completion(Object.assign({}, options, { field: value }))
            .then(response => {
                if (response && response.context && nextBlock) {
                    setContextUI(response, nextBlock)
                }
                return printResults(block, nextBlock, resultDom)(response)
            })
            .then(() => undefined) // so that restorePrompt sees no input on success
            .then(restorePrompt)
            .then(ui.installBlock(block.parentNode, block, nextBlock))        // <-- create a new input, for the next iter of the Loop
            .catch(err => { restorePrompt(); ui.oops(block, nextBlock)(err) })
    }

    return { mode: 'prompt' }
}

/** update the repl UI to signify the new context ctx */
const setContextUI = (ctx, block) => {
    const context = block.querySelector('.repl-context'),
          selection = block.querySelector('.repl-selection')

    if (selection.onclick) {
        // already done
        return
    }

    context.innerText = ctx.context || ctx // either a string or {context:'ccc'}

    // current selection? note that we always set the innerText, even if no selection, to clear out any prior text
    selection.innerText = !ctx.selection ? '' : ctx.selection.shortName || ctx.selection.name || ctx.selection
    selection.className = selection.className + ` has-selection-${!!ctx.selection}`

    context.onclick = () => repl.pexec(`cd ${ctx.context || ctx}`)

    if (ctx.selection) {
        selection.onclick = () => repl.pexec(`${ctx.context.replace(/\//g, ' ')} get ${ctx.selection.name || ctx.selection}`.trim())
    } else {
        // register a no-op
        selection.onclick = () => true
    }
}
self.setContextUI = setContextUI

/** no OpenWhisk authentication. enter a special context for first-timers */
self.setNoAuth = () => {
    //commandTree.changeContext('/welcome')()
    //setContextUI('welcome', ui.getCurrentBlock())
}

/**
 * If, while evaluating a command, it needs to evaluate a sub-command...
 *
 */
self.qfexec = (command, block, nextBlock, execOptions) => self.qexec(command, block, true, execOptions, nextBlock) // context change ok, final exec in a chain of nested execs
self.iexec = (command, block, contextChangeOK, execOptions, nextBlock) => self.qexec(command, block, contextChangeOK, Object.assign({}, execOptions, { intentional: true }), nextBlock)
self.qexec = (command, block, contextChangeOK, execOptions, nextBlock) => self.exec(command, Object.assign({ block: block, nextBlock: nextBlock, noHistory: true, contextChangeOK: contextChangeOK, type: 'nested' }, execOptions))

/**
 * Programmatic exec, as opposed to human typing and hitting enter
 *
 */
self.pexec = (command, execOptions) => self.exec(command, Object.assign({ echo: true, type: 'click-handler' }, execOptions))

const patterns = {
    commentLine: /\s*#.*$/,
    dash: /-([^\s]*)/,
    whitespace: /\s/
}

/**
 * Escape the given value so that it is compatible with command line execution
 *
 */
const escape = str => str.replace(patterns.dash, "'-$1'")

/**
  * Resolve the given string as a possible reference to an environment
  * variable; e.g. $FOO should resolve to 3 if process.env.FOO has
  * value 3.
  *
  */
const resolveEnvVar = variable => {
    const envValue = process.env[variable.substring(1)]
    return envValue ? escape(envValue) : variable
}

/**
 * Split the given string into an argv
 *
 */
const split = (str, removeOuterQuotes=true) => {
    const A = [],
          stack = []

    let cur = ''

    for (let idx = 0; idx < str.length; idx++) {
        const char = str.charAt(idx)

        if (stack.length === 0 && char.match(patterns.whitespace)) {
            if (cur.length > 0) {
                A.push(resolveEnvVar(cur))
                cur = ''
            }
            continue
        }

        const last = stack.length > 0 && stack[stack.length - 1]

        if (char === '{') {
            stack.push(char)
        } else if (char === '}' && last === '{') {
            stack.pop()
        }

        if (char === '\'' || char === '"') {

            if (char === last) {
                // found matching close quote
                stack.pop()

                if (stack.length > 0 || !removeOuterQuotes) {
                    // add the outer quotes?
                    cur += char
                }

            } else {
                // found open quote
                if (stack.length > 0 || !removeOuterQuotes) {
                    // add the outer quotes?
                    cur += char
                }

                stack.push(char)
            }
        } else {
            // not a quote
            cur += char
        }
    }

    if (cur.length > 0) {
        A.push(resolveEnvVar(cur))
    }

    return A
}
self.split = split

/** an empty promise, for blank lines */
const emptyPromise = () => {
    const emptyPromise = Promise.resolve()
    emptyPromise.isBlank = true
    return emptyPromise
}

/**
 * Remove any .repl-temporary structures from the given dom
 *
 */
const removeAnyTemps = block => {
    const temps = block.querySelectorAll('.repl-temporary')

    for (let idx = 0; idx < temps.length; idx++) {
        const temp = temps[idx]
        if (temp.parentNode) {
            temp.parentNode.removeChild(temp)
        }
    }

    return block
}

/** turn --foo into foo and -f into f */
const unflag = opt => opt.replace(/^[-]+/,'')

/**
 * Execute the given command-line
 *
 */
self.exec = (commandUntrimmed, execOptions) => {
    //debug(`repl::exec ${new Date()}`)
    debug('exec', commandUntrimmed)

    const echo = !execOptions || execOptions.echo !== false
    const nested = execOptions && execOptions.noHistory && !execOptions.replSilence
    if (nested) execOptions.nested = nested

    const block = execOptions && execOptions.block || ui.getCurrentBlock(),
          blockParent = block && block.parentNode, // remember this one, in case the command removes block from its parent
          prompt = block && ui.getPrompt(block)

    // maybe execOptions has been attached to the prompt dom (e.g. see repl.partial)
    if (!execOptions) execOptions = prompt.execOptions
    if (execOptions && execOptions.pip) {
        const { container, returnTo } = execOptions.pip
        try {
            return ui.pictureInPicture(commandUntrimmed, undefined, document.querySelector(container), returnTo)()
        } catch (err) {
            console.error(err)
            // fall through to normal execution, if pip fails
        }
    }

    // clone the current block so that we have one for the next
    // prompt, when we're done evaluating the current command
    let nextBlock
    if (!execOptions || (!execOptions.noHistory && echo)) {
        // this is a top-level exec
        ui.unlisten(prompt)
        nextBlock = (execOptions && execOptions.nextBlock) || block.cloneNode(true)

        // since we cloned it, make sure it's all cleaned out
        nextBlock.querySelector('input').value = ''
        nextBlock.querySelector('input').setAttribute('placeholder', 'enter your command')
    } else {
        // qfexec with nextBlock, see rm plugin
        nextBlock = execOptions && execOptions.nextBlock
    }

    if (nextBlock) {
        // remove any .repl-temporary that might've come along for the
        // ride when we cloned the current block
        removeAnyTemps(nextBlock)
    }

    // blank line, after removing comments?
    const command = commandUntrimmed.trim().replace(patterns.commentLine, '')
    if (!command) {
        if (block) {
            ui.setStatus(block, 'valid-response')
            ui.installBlock(blockParent, block, nextBlock)()
        }
        return emptyPromise()
    }

    if (execOptions && execOptions.echo && prompt) {
        // this is a programmatic exec, so make the command appear in the console
        prompt.value = commandUntrimmed
    }

    try {
        if (block && !nested && echo) {
            block.className = `${block.getAttribute('data-base-class')} processing`
            self.scrollIntoView({when:0,which:'.processing .repl-result'})
            prompt.readOnly = true
        }

        const argv = split(command)
        debug('split', command, argv)

        if (argv.length === 0) {
            if (block) {
                ui.setStatus(block, 'valid-response')
                ui.installBlock(blockParent, block, nextBlock)()
            }
            return emptyPromise()
        }

        debug(`issuing ${command} ${new Date()}`)

        // add a history entry
        if (!execOptions || !execOptions.noHistory && history) {
            if (!execOptions) {
                execOptions = {}
            }

            if (!execOptions || !execOptions.quiet) {
                execOptions.history = history.add({
                    raw: command
                })
            }
        }

        // the Read part of REPL
        const argvNoOptions = argv.filter(_ => _.charAt(0) !== '-')
        const evaluator = execOptions && execOptions.intentional ? commandTree.readIntention(argvNoOptions) : commandTree.read(argvNoOptions)

        if (evaluator && evaluator.eval) {
            const builtInOptions = [{ name: '--help', alias: '-h', hidden: true, boolean: true },
                                    { name: '--quiet', alias: '-q', hidden: true, boolean: true }]

            // here, we encode some common aliases, and then overlay any flags from the command
            // narg: any flags that take more than one argument e.g. -p key value would have { narg: { p: 2 } }
            const commandFlags = evaluator.options && evaluator.options.flags
                  || (evaluator.options && evaluator.options.synonymFor
                      && evaluator.options.synonymFor.options && evaluator.options.synonymFor.options.flags)
                  || {}
            const optional = builtInOptions.concat(evaluator.options && evaluator.options.usage && evaluator.options.usage.optional || [])
            const optionalBooleans = optional && optional.filter(({boolean}) => boolean).map(_ => unflag(_.name)),
                  optionalAliases = optional && optional.filter(({alias}) => alias).reduce((M,{name,alias}) => {
                      M[unflag(alias)] = unflag(name)
                      return M
                  }, {})

            const allFlags = {
                configuration: { 'camel-case-expansion': false },
                boolean: (commandFlags.boolean||[]).concat(optionalBooleans||[]),
                alias: Object.assign({}, commandFlags.alias || {}, optionalAliases || {}),
                narg: optional && optional.reduce((N, {name, alias, narg}) => {
                    if (narg) {
                        N[unflag(name)] = narg
                        N[unflag(alias)] = narg
                    }
                    return N
                }, {})
            }

            // now use minimist to parse the command line options
            // minimist stores the residual, non-opt, args in _
            const parsedOptions = minimist(argv, allFlags)
            const argv_no_options = parsedOptions._

            // if the user asked for help, and the plugin registered a
            // usage model, we can service that here, without having
            // to involve the plugin. this lets us avoid having each
            // plugin check for options.help
            if (parsedOptions.help && evaluator.options && evaluator.options.usage) {
                if (execOptions && execOptions.failWithUsage) {
                    return evaluator.options.usage
                } else {
                    return ui.oops(block, nextBlock)(new modules.errors.usage(evaluator.options.usage))
                }
            }

            //
            // check for argument conformance
            //
            const _usage = evaluator.options && evaluator.options.usage,
                  usage = _usage && _usage.fn ? _usage.fn(_usage.command) : _usage
            debug('usage', usage, evaluator)

            if (usage && usage.strict) { // strict: command wants *us* to enforce conformance
                // required and optional parameters
                const { strict:cmd, required=[], oneof=[], optional:_optional=[] } = usage,
                      optLikeOneOfs = oneof.filter(({command,name=command}) => name.charAt(0) === '-'), // some one-ofs might be of the form --foo
                      positionalConsumers = _optional.filter(({name, alias, consumesPositional}) => consumesPositional && (parsedOptions[unflag(name)] || parsedOptions[unflag(alias)])),
                      optional = builtInOptions.concat(_optional).concat(optLikeOneOfs),
                      positionalOptionals = optional.filter(({positional}) => positional),
                      nPositionalOptionals = positionalOptionals.length

                // just introducing a shorter variable name, here
                const args = argv_no_options,
                      nPositionalsConsumed = positionalConsumers.length,
                      nRequiredArgs = required.length + (oneof.length > 0 ? 1 : 0) - nPositionalsConsumed,
                      optLikeActuals = optLikeOneOfs.filter(({name, alias=''}) => parsedOptions.hasOwnProperty(unflag(name)) || parsedOptions.hasOwnProperty(unflag(alias))),
                      nOptLikeActuals = optLikeActuals.length,
                      cmdArgsStart = args.indexOf(cmd),
                      nActualArgs = args.length - cmdArgsStart - 1 + nOptLikeActuals

                // did the user pass an unsupported optional parameter?
                for (let optionalArg in parsedOptions) {
                    // skip over minimist's _
                    if (optionalArg !== '_'
                        && parsedOptions[optionalArg] !== false) { // minimist nonsense

                        // find a matching declared optional arg
                        const match = optional.find(({name, alias}) => {
                            return alias === `-${optionalArg}`
                                || name === `--${optionalArg}`
                        })

                        if (!match) {
                            // user passed an option, but the command doesn't accept it
                            const message = `Unsupported optional parameter ${optionalArg}`,
                                  err = new modules.errors.usage({ message, usage })
                            err.code = 499
                            debug(message, args, parsedOptions, optional, argv) // args is argv with options stripped
                            if (execOptions && execOptions.failWithUsage) {
                                return err
                            } else {
                                return ui.oops(block, nextBlock)(err)
                            }

                        } else if (match.boolean && typeof parsedOptions[optionalArg] !== 'boolean'
                                   || (match.booleanOK && !(typeof parsedOptions[optionalArg] === 'boolean' || typeof parsedOptions[optionalArg] === 'string'))
                                   || match.numeric && typeof parsedOptions[optionalArg] !== 'number'
                                   || match.narg > 1 && !Array.isArray(parsedOptions[optionalArg])
                                   || (!match.boolean && !match.booleanOK && !match.numeric && (!match.narg || match.narg === 1)
                                       && !(typeof parsedOptions[optionalArg] === 'string'
                                            || typeof parsedOptions[optionalArg] === 'number'
                                            || typeof parsedOptions[optionalArg] === 'boolean'))

                                   // is the given option not one of the allowed options
                                   || (match.allowed && !match.allowed.find(_ => _ === parsedOptions[optionalArg]
                                                                            || _ === '...'
                                                                            || match.allowedIsPrefixMatch && parsedOptions[optionalArg].indexOf(_) === 0))) {
                            // user passed an option, but of the wrong type
                            debug('bad value for option', optionalArg, match, parsedOptions, args, allFlags)
                            const expectedMessage = match.boolean ? ', expected boolean'
                                  : match.numeric ? ', expected a number' : '',
                                  message = `Bad value for option ${optionalArg}${expectedMessage},${typeof parsedOptions[optionalArg] === 'boolean' ? '' : ' got ' + parsedOptions[optionalArg]}${match.allowed ? ' expected one of: ' + match.allowed.join(', ') : ''}`
                                  error = new modules.errors.usage({ message, usage })
                            debug(message, match)
                            error.code = 498
                            if (execOptions && execOptions.failWithUsage) {
                                return error
                            } else {
                                return ui.oops(block, nextBlock)(error)
                            }
                        }
                    }
                }

                //
                // user passed an incorrect number of positional parameters?
                //
                if (nActualArgs !== nRequiredArgs) {
                    if (nActualArgs != nRequiredArgs + nPositionalOptionals) {
                        // yup, scan for implicitOK
                        const implicitIdx = required.findIndex(({implicitOK}) => implicitOK),
                              selection = ui.currentSelection()

                        let nActualArgsWithImplicit = nActualArgs

                        if (implicitIdx >= 0 && selection && required[implicitIdx].implicitOK.find(_ => _ === selection.type
                                                                                                   || _ === selection.prettyType)) {
                            nActualArgsWithImplicit++

                            // if implicit, maybe other required parameters aren't needed
                            const notNeededIfImplicit = required.filter(({notNeededIfImplicit}) => notNeededIfImplicit)
                            nActualArgsWithImplicit += notNeededIfImplicit.length
                        }

                        if (nActualArgsWithImplicit !== nRequiredArgs) {
                            // then either the command didn't specify
                            // implicitOK, or the current selection
                            // (or lack thereof) didn't match with the
                            // command's typing requirement
                            const message = nRequiredArgs === 0 ? 'This command accepts no positional arguments'
                                  : `This command requires ${nRequiredArgs} parameter${nRequiredArgs === 1 ? '' : 's'}, but you provided ${nActualArgsWithImplicit === 0 ? 'none' : nActualArgsWithImplicit}`,
                                  err = new modules.errors.usage({ message, usage })
                            err.code = 497
                            debug(message, cmd, nActualArgs, nRequiredArgs, args, optLikeActuals)

                            if (execOptions && execOptions.nested) {
                                return err
                            } else {
                                return ui.oops(block, nextBlock)(err)
                            }

                        } else {
                            // ooh, then splice in the implicit parameter
                            args.splice(implicitIdx, cmdArgsStart + 1, selection.namespace ? `/${selection.namespace}/${selection.name}` : selection.name)
                            debug('spliced in implicit argument', cmdArgsStart, implicitIdx, args)
                        }
                    }
                }
            }

            // if we don't have a head (yet), but this command
            // requires one, then ask for a head and try again. note
            // that we ignore this needsUI constraint if the user is
            // asking for help
            if (ui.headless && evaluator.options && evaluator.options.needsUI && !parsedOptions.help && !parsedOptions.cli) {
                ui.createWindow(argv, evaluator.options.fullscreen, evaluator.options) // source for ths is in headless.js
                return Promise.resolve(true)
            }

            if (execOptions && execOptions.placeholder) {
                prompt.value = execOptions.placeholder
            }

            //
            // the Eval part of REPL
            //
            return Promise.resolve()
                .then(() => evaluator.eval(block||true, nextBlock, argv, modules, command, execOptions, argv_no_options, parsedOptions))
                .then(response => {
                    if (response && response.context && nextBlock) {
                        setContextUI(response, nextBlock)
                        return response.message
                    } else {
                        return response
                    }
                })
                .then(response => {
                    if (response === undefined) {
                        // weird, the response is empty!
                        console.error(argv)
                        throw new Error('Internal Error')
                    }

                    if (block && block.isCancelled) {
                        // user cancelled the command
                        debug('squashing output of cancelled command')
                        return
                    }

                    if (response.verb === 'delete') {
                        if (ui.maybeHideEntity(response) && nextBlock) {
                            setContextUI(commandTree.currentContext(), nextBlock)
                        }
                    }

                    // indicate that the command was successfuly completed
                    evaluator.success({ type: execOptions && execOptions.type || 'top-level',
                                        parsedOptions })

                    // response=true means we are in charge of 'ok'
                    if (nested || response.mode === 'prompt') {
                        // the parent exec will deal with the repl
                        return Promise.resolve(response)
                    } else {
                        // we're the top-most exec, so deal with the repl!
                        const resultDom = block.querySelector('.repl-result')
                        return new Promise(resolve => {
                            printResults(block, nextBlock, resultDom, echo, execOptions, parsedOptions)(response)  // <--- the Print part of REPL
                                .then(() => {
                                    if (echo) {
                                        // <-- create a new input, for the next iter of the Loop
                                        setTimeout(() => {
                                            ui.installBlock(blockParent, block, nextBlock)()
                                            resolve(response)
                                        }, 100)
                                    } else {
                                        resolve(response)
                                    }
                                })
                                .catch(err => {
                                    console.error(err)
                                    if (execOptions && execOptions.noHistory) {
                                        // then pass the error upstream
                                        throw err
                                    } else {
                                        // then report the error to the repl
                                        ui.oops(block, nextBlock)(err)
                                    }
                                });
                        })
                    }
                })
                .catch(err => {
                    // console.error('error in command execution', err)

                    if (ui.headless) {
                        throw err
                    } else {
                        // indicate that the command was NOT successfuly completed
                        evaluator.error(err)

                        // how should we handle the error?
                        const returnIt = execOptions && execOptions.failWithUsage,   // return to caller; it'll take care of things from now
                              rethrowIt = execOptions && execOptions.rethrowErrors,  // rethrow the exception
                              reportIt = execOptions && execOptions.reportErrors     // report it to the user via the repl

                        if (returnIt) {
                            debug('returning command execution error')
                            return err
                        } else if (!nested && !rethrowIt) {
                            debug('reporting command execution error to user via repl')
                            ui.oops(block, nextBlock)(err)
                        } else {
                            debug('rethrowing command execution error')
                            if (reportIt) {
                                // maybe the caller also wants us to report it via the repl?
                                debug('also reporting command execution error to user via repl')
                                ui.oops(block, nextBlock)(err)
                            }
                            throw err
                        }
                    }
                })
        }
    } catch (e) {
        if (execOptions && execOptions.failWithUsage) {
            return e
        } else if (ui.headless) {
            throw e
        }

        console.error('catastrophic error in repl')
        console.error(e)

        const blockForError = block || ui.getCurrentProcessingBlock()

        return Promise.resolve(e.message).then(message => {
            if (message.nodeName) {
                e.message = message
                ui.oops(block, nextBlock)(e)

            } else {
                const cmd = help.show(blockForError, nextBlock, message || 'Unknown command')
                const resultDom = blockForError.querySelector('.repl-result')
                return Promise.resolve(cmd)
                    .then(printResults(blockForError, nextBlock, resultDom))
                    .then(ui.installBlock(blockForError.parentNode, blockForError, nextBlock))
            }
        })
    }
}


/**
  * Paste a command, but do not eval it
  *
  */
self.partial = (cmd, execOptions) => {
    const prompt = ui.getCurrentPrompt()
    if (prompt) {
        prompt.value = cmd
        prompt.execOptions = execOptions
        prompt.classList.add('repl-partial')
        setTimeout(() => prompt.classList.remove('repl-partial'), 1000)
        ui.getCurrentPrompt().focus()
    }
}

/**
 * User has requested that we paste something from the clipboard
 *
 */
self.paste = event => {
    const text = event.clipboardData.getData('text')
    if (text) {
        // we'll handle it from here!
        event.preventDefault()

        const prompt = event.currentTarget,
              lines = text.split(/\n|\r/)

        const pasteLooper = idx => {
            if (idx === lines.length) {
                // all done...
                return Promise.resolve()
            } else if (lines[idx] === '') {
                // then this is a blank line, so skip it
                return pasteLooper(idx + 1)
            } else if (idx <= lines.length - 2) {
                // then this is a command line with a trailing newline
                return repl.pexec(ui.getCurrentPrompt().value + lines[idx])
                    .then(() => pasteLooper(idx + 1))
            } else {
                // then this is the last line, but without a trailing newline.
                // here, we add this command line to the current prompt, without executing it
                ui.getCurrentPrompt().value += lines[idx]
                return Promise.resolve()
            }
        }
        
        return pasteLooper(0)
    }
}

/**
 * User has requested that we "cancel" whatever is currently happening.
 *
 * If there is nothing happening, then terminate the current prompt
 * and start a new one
 *
 * TODO cancel the actual command?
 *
 */
self.doCancel = () => {
    debug('doCancel')

    const block = removeAnyTemps(ui.getCurrentProcessingBlock() || ui.getCurrentBlock()),
          nextBlock = block.cloneNode(true),
          nextBlockPrompt = ui.getPrompt(nextBlock)

    block.className = `${block.getAttribute('data-base-class')} cancelled`
    block.isCancelled = true
    nextBlockPrompt.value = ''
    nextBlockPrompt.readOnly = false // in case we cancelled a block in-progress - the cloneNode will pick up the readonly attribute, which we need to remove

    ui.unlisten(ui.getPrompt(block))
    ui.installBlock(block.parentNode, block, nextBlock)()
}

/**
 * Add quotes if the argument needs it; compare to encodeURIComponent
 *
 */
self.encodeComponent = (component, quote='"') => {
    if (component.match(patterns.whitespace)) {
        return `${quote}${component}${quote}`
    } else {
        return component
    }
}

module.exports = self

debug('loading done')
