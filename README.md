<div align="center">

<a id="arcade"></a>
<img src="https://arcade.tangobee.dev/screen.svg" width="100%" alt="TANGOBEE ARCADE — a live snake game played by everyone who visits this profile">

<a href="https://arcade.tangobee.dev/left"><img src="https://arcade.tangobee.dev/pad/left.svg" width="84" alt="left" title="move left — for everyone"></a>
<a href="https://arcade.tangobee.dev/up"><img src="https://arcade.tangobee.dev/pad/up.svg" width="84" alt="up" title="move up — for everyone"></a>
<a href="https://arcade.tangobee.dev/down"><img src="https://arcade.tangobee.dev/pad/down.svg" width="84" alt="down" title="move down — for everyone"></a>
<a href="https://arcade.tangobee.dev/right"><img src="https://arcade.tangobee.dev/pad/right.svg" width="84" alt="right" title="move right — for everyone"></a>

<sub>this is one shared game. every arrow you click moves the same snake for everyone on earth. no login, no fork, just click.</sub>

<details>
<summary><sub>wait, how is this possible on a github readme?</sub></summary>
<br>

<sub>github strips javascript, css and iframes from readmes, so the screen is just an image — but one served fresh on every page load by a tiny cloudflare worker that holds the game state. each arrow is a plain link: the worker applies your move, works out roughly which city you're in, and redirects you straight back here, so the page reloads with the new frame. source: <a href="arcade/src/worker.js">arcade/src/worker.js</a></sub>

</details>

</div>
