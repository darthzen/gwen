Gwen's persona (her system prompt) is not in this repository.

Edit it here:

    ~/Developer/lab-fleet/17-buzz/gwen/SOUL.md
    https://github.com/darthzen/lab-fleet/blob/main/17-buzz/gwen/SOUL.md

Commit and push that file to main. Fleet delivers it to the running pod as a
ConfigMap and restarts Gwen with it; no image build is needed.

The service reads the persona from the file named by GWEN_PERSONA_FILE and
refuses to start without it. To run Gwen locally with the deployed persona:

    GWEN_PERSONA_FILE=~/Developer/lab-fleet/17-buzz/gwen/SOUL.md \
      OPENROUTER_API_KEY=... GWEN_ADAPTERS=cli npm run dev
