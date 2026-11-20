// The browser connector is a built-in with no credentials, so it needs no auth form. The
// settings page predates it and is kept as one frozen script, so build-webview.mjs appends
// this file to that script. Sharing its scope lets the browser modal reuse the page's own
// `infoParagraph`, `renderAuthFields`, `updateModalActions` and `closeModal`.
{
    const renderConnectorAuthFields = renderAuthFields
    renderAuthFields = (id, manifest) => {
        if (id === 'browser') {
            const container = document.getElementById('modal-auth-fields')
            container.replaceChildren()
            container.appendChild(infoParagraph(
                'Fetches and reads web pages from this device. No sign-in is required; each tool keeps its own approval policy below.'
            ))
            return
        }
        renderConnectorAuthFields(id, manifest)
    }

    const updateConnectorModalActions = updateModalActions
    updateModalActions = (id, manifest, connected) => {
        updateConnectorModalActions(id, manifest, connected)
        if (id !== 'browser') return
        const primary = document.getElementById('modal-primary')
        primary.textContent = 'Done'
        primary.onclick = () => { closeModal() }
    }
}
