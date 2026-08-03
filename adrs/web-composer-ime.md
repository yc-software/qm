I've been using QM with Japanese input and found that pressing Enter to confirm an IME conversion can submit the message early. This sometimes sends half-finished text and leaves the rest in the composer.

I think the web composer should ignore Enter while IME composition is active, then let the next normal Enter submit the completed text. Safari's `keyCode === 229` behavior probably needs to be covered too.

I tested this behavior with normal messages and mid-run steering on our deployment. Japanese input worked as expected, while English Enter and Shift+Enter kept their existing behavior. I also have a tested implementation in the preserved [`hotfix/web-composer-ime`](https://github.com/foxytanuki/qm/tree/hotfix/web-composer-ime) branch if that's useful.
