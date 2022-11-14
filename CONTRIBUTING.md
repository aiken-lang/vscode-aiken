# Contributing

```sh
# Install deps
npm run install

# Compile the plugin
npm run compile

# Or compile the plugin every time a file is saved
npm run dev
```

In VS Code press F5 and a new VS Code window
should open with the extension loaded.

## Publishing a new version of the extension

### VS Code marketplace

```shell
npm run build
```

Now you can drag and drop the package file into the marketplace.

<https://code.visualstudio.com/api/working-with-extensions/publishing-extension>

<https://marketplace.visualstudio.com/manage/publishers/txpipe>

### Open VSX

```shell
npx ovsx publish --pat $TOKEN
```

You can get a token here, assuming you don't have one saved already. https://open-vsx.org/user-settings/tokens
