(()=>{var B=globalThis,j=B.ShadowRoot&&(B.ShadyCSS===void 0||B.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,ce=Symbol(),de=new WeakMap,F=class{constructor(e,t,s){if(this._$cssResult$=!0,s!==ce)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o,t=this.t;if(j&&e===void 0){let s=t!==void 0&&t.length===1;s&&(e=de.get(t)),e===void 0&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),s&&de.set(t,e))}return e}toString(){return this.cssText}},pe=i=>new F(typeof i=="string"?i:i+"",void 0,ce);var he=(i,e)=>{if(j)i.adoptedStyleSheets=e.map(t=>t instanceof CSSStyleSheet?t:t.styleSheet);else for(let t of e){let s=document.createElement("style"),n=B.litNonce;n!==void 0&&s.setAttribute("nonce",n),s.textContent=t.cssText,i.appendChild(s)}},J=j?i=>i:i=>i instanceof CSSStyleSheet?(e=>{let t="";for(let s of e.cssRules)t+=s.cssText;return pe(t)})(i):i;var{is:Me,defineProperty:De,getOwnPropertyDescriptor:Le,getOwnPropertyNames:He,getOwnPropertySymbols:Ue,getPrototypeOf:Oe}=Object,q=globalThis,ue=q.trustedTypes,Re=ue?ue.emptyScript:"",Ie=q.reactiveElementPolyfillSupport,L=(i,e)=>i,Q={toAttribute(i,e){switch(e){case Boolean:i=i?Re:null;break;case Object:case Array:i=i==null?i:JSON.stringify(i)}return i},fromAttribute(i,e){let t=i;switch(e){case Boolean:t=i!==null;break;case Number:t=i===null?null:Number(i);break;case Object:case Array:try{t=JSON.parse(i)}catch{t=null}}return t}},me=(i,e)=>!Me(i,e),ge={attribute:!0,type:String,converter:Q,reflect:!1,useDefault:!1,hasChanged:me};Symbol.metadata??=Symbol("metadata"),q.litPropertyMetadata??=new WeakMap;var S=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=ge){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){let s=Symbol(),n=this.getPropertyDescriptor(e,s,t);n!==void 0&&De(this.prototype,e,n)}}static getPropertyDescriptor(e,t,s){let{get:n,set:a}=Le(this.prototype,e)??{get(){return this[t]},set(o){this[t]=o}};return{get:n,set(o){let p=n?.call(this);a?.call(this,o),this.requestUpdate(e,p,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??ge}static _$Ei(){if(this.hasOwnProperty(L("elementProperties")))return;let e=Oe(this);e.finalize(),e.l!==void 0&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(L("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(L("properties"))){let t=this.properties,s=[...He(t),...Ue(t)];for(let n of s)this.createProperty(n,t[n])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[s,n]of t)this.elementProperties.set(s,n)}this._$Eh=new Map;for(let[t,s]of this.elementProperties){let n=this._$Eu(t,s);n!==void 0&&this._$Eh.set(n,t)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let s=new Set(e.flat(1/0).reverse());for(let n of s)t.unshift(J(n))}else e!==void 0&&t.push(J(e));return t}static _$Eu(e,t){let s=t.attribute;return s===!1?void 0:typeof s=="string"?s:typeof e=="string"?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){let e=new Map,t=this.constructor.elementProperties;for(let s of t.keys())this.hasOwnProperty(s)&&(e.set(s,this[s]),delete this[s]);e.size>0&&(this._$Ep=e)}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return he(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,s){this._$AK(e,s)}_$ET(e,t){let s=this.constructor.elementProperties.get(e),n=this.constructor._$Eu(e,s);if(n!==void 0&&s.reflect===!0){let a=(s.converter?.toAttribute!==void 0?s.converter:Q).toAttribute(t,s.type);this._$Em=e,a==null?this.removeAttribute(n):this.setAttribute(n,a),this._$Em=null}}_$AK(e,t){let s=this.constructor,n=s._$Eh.get(e);if(n!==void 0&&this._$Em!==n){let a=s.getPropertyOptions(n),o=typeof a.converter=="function"?{fromAttribute:a.converter}:a.converter?.fromAttribute!==void 0?a.converter:Q;this._$Em=n;let p=o.fromAttribute(t,a.type);this[n]=p??this._$Ej?.get(n)??p,this._$Em=null}}requestUpdate(e,t,s,n=!1,a){if(e!==void 0){let o=this.constructor;if(n===!1&&(a=this[e]),s??=o.getPropertyOptions(e),!((s.hasChanged??me)(a,t)||s.useDefault&&s.reflect&&a===this._$Ej?.get(e)&&!this.hasAttribute(o._$Eu(e,s))))return;this.C(e,t,s)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(e,t,{useDefault:s,reflect:n,wrapped:a},o){s&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,o??t??this[e]),a!==!0||o!==void 0)||(this._$AL.has(e)||(this.hasUpdated||s||(t=void 0),this._$AL.set(e,t)),n===!0&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(t){Promise.reject(t)}let e=this.scheduleUpdate();return e!=null&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(let[n,a]of this._$Ep)this[n]=a;this._$Ep=void 0}let s=this.constructor.elementProperties;if(s.size>0)for(let[n,a]of s){let{wrapped:o}=a,p=this[n];o!==!0||this._$AL.has(n)||p===void 0||this.C(n,void 0,a,p)}}let e=!1,t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(s=>s.hostUpdate?.()),this.update(t)):this._$EM()}catch(s){throw e=!1,this._$EM(),s}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(t=>t.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(t=>this._$ET(t,this[t])),this._$EM()}updated(e){}firstUpdated(e){}};S.elementStyles=[],S.shadowRootOptions={mode:"open"},S[L("elementProperties")]=new Map,S[L("finalized")]=new Map,Ie?.({ReactiveElement:S}),(q.reactiveElementVersions??=[]).push("2.1.2");var ie=globalThis,be=i=>i,K=ie.trustedTypes,ve=K?K.createPolicy("lit-html",{createHTML:i=>i}):void 0,Se="$lit$",_=`lit$${Math.random().toFixed(9).slice(2)}$`,_e="?"+_,ze=`<${_e}>`,C=document,U=()=>C.createComment(""),O=i=>i===null||typeof i!="object"&&typeof i!="function",ne=Array.isArray,Be=i=>ne(i)||typeof i?.[Symbol.iterator]=="function",Y=`[ 	
\f\r]`,H=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,fe=/-->/g,ye=/>/g,x=RegExp(`>|${Y}(?:([^\\s"'>=/]+)(${Y}*=${Y}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),$e=/'/g,we=/"/g,Ee=/^(?:script|style|textarea|title)$/i,ae=i=>(e,...t)=>({_$litType$:i,strings:e,values:t}),l=ae(1),ot=ae(2),rt=ae(3),T=Symbol.for("lit-noChange"),v=Symbol.for("lit-nothing"),Ae=new WeakMap,k=C.createTreeWalker(C,129);function xe(i,e){if(!ne(i)||!i.hasOwnProperty("raw"))throw Error("invalid template strings array");return ve!==void 0?ve.createHTML(e):e}var Fe=(i,e)=>{let t=i.length-1,s=[],n,a=e===2?"<svg>":e===3?"<math>":"",o=H;for(let p=0;p<t;p++){let r=i[p],g,u,h=-1,$=0;for(;$<r.length&&(o.lastIndex=$,u=o.exec(r),u!==null);)$=o.lastIndex,o===H?u[1]==="!--"?o=fe:u[1]!==void 0?o=ye:u[2]!==void 0?(Ee.test(u[2])&&(n=RegExp("</"+u[2],"g")),o=x):u[3]!==void 0&&(o=x):o===x?u[0]===">"?(o=n??H,h=-1):u[1]===void 0?h=-2:(h=o.lastIndex-u[2].length,g=u[1],o=u[3]===void 0?x:u[3]==='"'?we:$e):o===we||o===$e?o=x:o===fe||o===ye?o=H:(o=x,n=void 0);let d=o===x&&i[p+1].startsWith("/>")?" ":"";a+=o===H?r+ze:h>=0?(s.push(g),r.slice(0,h)+Se+r.slice(h)+_+d):r+_+(h===-2?p:d)}return[xe(i,a+(i[t]||"<?>")+(e===2?"</svg>":e===3?"</math>":"")),s]},R=class i{constructor({strings:e,_$litType$:t},s){let n;this.parts=[];let a=0,o=0,p=e.length-1,r=this.parts,[g,u]=Fe(e,t);if(this.el=i.createElement(g,s),k.currentNode=this.el.content,t===2||t===3){let h=this.el.content.firstChild;h.replaceWith(...h.childNodes)}for(;(n=k.nextNode())!==null&&r.length<p;){if(n.nodeType===1){if(n.hasAttributes())for(let h of n.getAttributeNames())if(h.endsWith(Se)){let $=u[o++],d=n.getAttribute(h).split(_),b=/([.?@])?(.*)/.exec($);r.push({type:1,index:a,name:b[2],strings:d,ctor:b[1]==="."?X:b[1]==="?"?ee:b[1]==="@"?te:N}),n.removeAttribute(h)}else h.startsWith(_)&&(r.push({type:6,index:a}),n.removeAttribute(h));if(Ee.test(n.tagName)){let h=n.textContent.split(_),$=h.length-1;if($>0){n.textContent=K?K.emptyScript:"";for(let d=0;d<$;d++)n.append(h[d],U()),k.nextNode(),r.push({type:2,index:++a});n.append(h[$],U())}}}else if(n.nodeType===8)if(n.data===_e)r.push({type:2,index:a});else{let h=-1;for(;(h=n.data.indexOf(_,h+1))!==-1;)r.push({type:7,index:a}),h+=_.length-1}a++}}static createElement(e,t){let s=C.createElement("template");return s.innerHTML=e,s}};function P(i,e,t=i,s){if(e===T)return e;let n=s!==void 0?t._$Co?.[s]:t._$Cl,a=O(e)?void 0:e._$litDirective$;return n?.constructor!==a&&(n?._$AO?.(!1),a===void 0?n=void 0:(n=new a(i),n._$AT(i,t,s)),s!==void 0?(t._$Co??=[])[s]=n:t._$Cl=n),n!==void 0&&(e=P(i,n._$AS(i,e.values),n,s)),e}var Z=class{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){let{el:{content:t},parts:s}=this._$AD,n=(e?.creationScope??C).importNode(t,!0);k.currentNode=n;let a=k.nextNode(),o=0,p=0,r=s[0];for(;r!==void 0;){if(o===r.index){let g;r.type===2?g=new I(a,a.nextSibling,this,e):r.type===1?g=new r.ctor(a,r.name,r.strings,this,e):r.type===6&&(g=new se(a,this,e)),this._$AV.push(g),r=s[++p]}o!==r?.index&&(a=k.nextNode(),o++)}return k.currentNode=C,n}p(e){let t=0;for(let s of this._$AV)s!==void 0&&(s.strings!==void 0?(s._$AI(e,s,t),t+=s.strings.length-2):s._$AI(e[t])),t++}},I=class i{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,s,n){this.type=2,this._$AH=v,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=s,this.options=n,this._$Cv=n?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode,t=this._$AM;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=P(this,e,t),O(e)?e===v||e==null||e===""?(this._$AH!==v&&this._$AR(),this._$AH=v):e!==this._$AH&&e!==T&&this._(e):e._$litType$!==void 0?this.$(e):e.nodeType!==void 0?this.T(e):Be(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==v&&O(this._$AH)?this._$AA.nextSibling.data=e:this.T(C.createTextNode(e)),this._$AH=e}$(e){let{values:t,_$litType$:s}=e,n=typeof s=="number"?this._$AC(e):(s.el===void 0&&(s.el=R.createElement(xe(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===n)this._$AH.p(t);else{let a=new Z(n,this),o=a.u(this.options);a.p(t),this.T(o),this._$AH=a}}_$AC(e){let t=Ae.get(e.strings);return t===void 0&&Ae.set(e.strings,t=new R(e)),t}k(e){ne(this._$AH)||(this._$AH=[],this._$AR());let t=this._$AH,s,n=0;for(let a of e)n===t.length?t.push(s=new i(this.O(U()),this.O(U()),this,this.options)):s=t[n],s._$AI(a),n++;n<t.length&&(this._$AR(s&&s._$AB.nextSibling,n),t.length=n)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){let s=be(e).nextSibling;be(e).remove(),e=s}}setConnected(e){this._$AM===void 0&&(this._$Cv=e,this._$AP?.(e))}},N=class{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,s,n,a){this.type=1,this._$AH=v,this._$AN=void 0,this.element=e,this.name=t,this._$AM=n,this.options=a,s.length>2||s[0]!==""||s[1]!==""?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=v}_$AI(e,t=this,s,n){let a=this.strings,o=!1;if(a===void 0)e=P(this,e,t,0),o=!O(e)||e!==this._$AH&&e!==T,o&&(this._$AH=e);else{let p=e,r,g;for(e=a[0],r=0;r<a.length-1;r++)g=P(this,p[s+r],t,r),g===T&&(g=this._$AH[r]),o||=!O(g)||g!==this._$AH[r],g===v?e=v:e!==v&&(e+=(g??"")+a[r+1]),this._$AH[r]=g}o&&!n&&this.j(e)}j(e){e===v?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}},X=class extends N{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===v?void 0:e}},ee=class extends N{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==v)}},te=class extends N{constructor(e,t,s,n,a){super(e,t,s,n,a),this.type=5}_$AI(e,t=this){if((e=P(this,e,t,0)??v)===T)return;let s=this._$AH,n=e===v&&s!==v||e.capture!==s.capture||e.once!==s.once||e.passive!==s.passive,a=e!==v&&(s===v||n);n&&this.element.removeEventListener(this.name,this,s),a&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}},se=class{constructor(e,t,s){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(e){P(this,e)}};var je=ie.litHtmlPolyfillSupport;je?.(R,I),(ie.litHtmlVersions??=[]).push("3.3.3");var W=(i,e,t)=>{let s=t?.renderBefore??e,n=s._$litPart$;if(n===void 0){let a=t?.renderBefore??null;s._$litPart$=n=new I(e.insertBefore(U(),a),a,void 0,t??{})}return n._$AI(i),n};var oe=globalThis,M=class extends S{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=W(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return T}};M._$litElement$=!0,M.finalized=!0,oe.litElementHydrateSupport?.({LitElement:M});var qe=oe.litElementPolyfillSupport;qe?.({LitElement:M});(oe.litElementVersions??=[]).push("4.2.2");function ke(i){let e=i.appendChild(document.createComment(""));return t=>{e.parentNode===i&&W(t,i,{renderBefore:e})}}var Ke=[["--bg","Page behind every surface"],["--surface","Cards, dialogs, table bodies"],["--subtle","Quiet control and inset backgrounds"],["--border","Every hairline and divider"],["--text","Primary copy"],["--muted","Secondary copy and hints"],["--cta","Primary actions and selected controls"],["--ok","Confirmed and healthy"],["--warn","Needs attention"],["--danger","Destructive and failed"],["--trigger","Automation and triggers"]];function Ce(i){let e=document.getElementById("view-design");if(e.dataset.litDesign)return;e.dataset.litDesign="true";let t=ke(e),s={scopeStatus:"Choose a scope to try the row interaction.",fileStatus:"File names, thumbnails, sizes, and dates stay visible.",packStatus:"Registration is a local demonstration.",searchStatus:"Type to try the search field, then clear it.",toggleStatus:"Selected: Human activity",advanced:!1,name:"Acme",savedName:"Acme",nameSaved:!1,chip:!0},n=m=>{Object.assign(s,m),E()},a=()=>document.getElementById("design-dialog"),o=i.searchField({placeholder:"Search messages\u2026",onInput:m=>n({searchStatus:m?"Search query: "+m:"Type to try the search field, then clear it."})}),p=i.searchField({placeholder:"Search messages\u2026",value:"Product updates"}),r=i.searchField({placeholder:"Search unavailable",disabled:!0}),g=[{value:"human",label:"Human activity"},{value:"all",label:"All activity"}],u=i.twoWayToggle({label:"Example activity sort",options:g,value:"human",onChange:m=>n({toggleStatus:"Selected: "+g.find(c=>c.value===m).label})}),h=i.twoWayToggle({label:"Disabled activity sort",options:g,value:"human",disabled:!0,onChange:()=>{}}),$=()=>l`<div class="dense-list">
      ${[{name:"Example team",preview:"12 skills",time:"5 mins ago"},{name:"Research",preview:"4 skills",time:"Yesterday"}].map(m=>l`<div
            class="dense-row"
            tabindex="0"
            role="button"
            @click=${()=>n({scopeStatus:"Selected: "+m.name})}
            @keydown=${c=>{c.key==="Enter"&&n({scopeStatus:"Selected: "+m.name})}}
          >
            <span class="dense-name">${m.name}</span><span class="dense-preview">${m.preview}</span
            ><span class="dense-time">${m.time}</span>
          </div>`)}
    </div>`,d=[{name:"Research brief.pdf",size:"240 KB",date:"Today"},{name:"Project notes.md",size:"8 KB",date:"Yesterday"}].map(m=>({...m,thumb:i.fileThumb(m)})),b=()=>l`<div class="dense-list">
      ${d.map(m=>l`<div
            class="dense-row"
            tabindex="0"
            role="button"
            @click=${()=>n({fileStatus:"Selected: "+m.name+" (demo only)"})}
            @keydown=${c=>{c.key==="Enter"&&n({fileStatus:"Selected: "+m.name+" (demo only)"})}}
          >
            <span class="dense-icon">${m.thumb}</span><span class="dense-name">${m.name}</span
            ><span class="dense-preview">Example team</span
            ><span class="dense-time">${m.size+" \xB7 "+m.date}</span>
          </div>`)}
    </div>`;function f(){return s.name!==s.savedName?"Unsaved changes":s.nameSaved?"Saved in this example":"No changes"}function E(){let m=[],c=(y,z,G,Ne=!1)=>l`<div class="spec">
        <div class="spec-label">${y}${z?l`<span>${z}</span>`:v}</div>
        <div class=${"spec-demo"+(Ne?" stack":"")}>${G}</div>
      </div>`,re=y=>"design-group-"+y.toLowerCase().replace(/[^a-z0-9]+/g,"-"),A=(y,z,G)=>(m.push(y),l`<section class="design-group" id=${re(y)}>
        <h2>${y}</h2>
        <p>${z}</p>
        ${G}
      </section>`),Pe=Ke.map(y=>l`<div class="swatch">
          <div class="swatch-chip" style=${"background: var("+y[0]+")"}></div>
          <div class="swatch-meta"><b>${y[0]}</b>${y[1]}</div>
        </div>`),le=[l`<p class="lead">
        Components and page patterns from the redesigned admin portal, including Skills, Files, Sessions, Metrics,
        Audit, and Egress. Examples use fictional data and do not save changes.
      </p>`,A("Foundations","One palette, a small type scale, and consistent spacing.",[c("Semantic colors","Shared theme tokens \xB7 light and dark",l`<div class="swatches">${Pe}</div>`),c("Type & spacing","22px page title \xB7 14px section title \xB7 13px controls and copy",l`<div class="shell-title">Page title</div>
            <div class="head">
              <h2>Section title</h2>
              <p>Descriptions explain the setting.</p>
            </div>
            <label>Field label</label>
            <p class="hint">4px label gap · 8px action gap · 24px section spacing</p>`,!0)]),A("Page layout","Start with the shared shell. Align titles, sections, and rows to the same content edge; use whitespace and dividers instead of enclosing cards.",[c("Desktop and mobile","Authored layout diagrams \xB7 .admin-main \u2192 .admin-inner \u2192 .shellbar",l`<div class="design-layouts">
              <div class="design-layout-frame">
                <div class="design-layout-nav">Sidebar<br />Independent scroll</div>
                <div class="design-layout-main">
                  <div class="design-layout-content">
                    <div class="design-layout-title">Title <span>Search / action</span></div>
                    <div class="design-layout-section">Open section<br /><small>Heading + description</small></div>
                    <div class="design-layout-lines">Compact rows<br />────────────────<br />Compact rows</div>
                  </div>
                </div>
              </div>
              <div class="design-layout-frame mobile">
                <div class="design-layout-nav">Horizontal navigation</div>
                <div class="design-layout-main">
                  <div class="design-layout-content">
                    <div class="design-layout-title">Title</div>
                    <div class="design-layout-section">Full-width search</div>
                    <div class="design-layout-lines">Stacked content<br />────────────<br />Local table scroll</div>
                  </div>
                </div>
              </div>
            </div>`,!0),c("Width and page padding","Current New CSS \xB7 index.html and admin-components.css",l`<div class="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Desktop</th>
                    <th>Small screens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Navigation</td>
                    <td>280px sidebar; independent scroll</td>
                    <td>Horizontal navigation at ≤900px</td>
                  </tr>
                  <tr>
                    <td>Content width</td>
                    <td>960px maximum, centered; fluid below that</td>
                    <td>Available width; min-width: 0</td>
                  </tr>
                  <tr>
                    <td>Main padding</td>
                    <td>28px top and sides</td>
                    <td>At ≤900px: 18px top, 14px sides with safe-area insets</td>
                  </tr>
                  <tr>
                    <td>Bottom clearance</td>
                    <td colspan="2">110px for the fixed Original / New switch</td>
                  </tr>
                  <tr>
                    <td>Page heading</td>
                    <td colspan="2">22px / 500 weight; shared shell spacing 16px (activity pages use 24px)</td>
                  </tr>
                  <tr>
                    <td>Sections</td>
                    <td colspan="2">24px between artifact sections; 12px from section heading to content</td>
                  </tr>
                  <tr>
                    <td>Controls</td>
                    <td colspan="2">32px height · 6px radius · 8px gap · 4px label gap</td>
                  </tr>
                </tbody>
              </table>
            </div>`,!0),c("Choose a page pattern","Live references \xB7 preserve the selected organization",l`<div class="design-page-links">
              <a
                data-design-view="governance"
                href=${i.stateToUrl({view:"governance",scope:i.scope()})}
                >Governance / Models</a
              >
              <p>
                Descriptions beside settings, 40px column gap; stack on small screens. Keep Apply right-aligned with
                status on its left.
              </p>
              <a data-design-view="skills" href=${i.stateToUrl({view:"skills",scope:i.scope()})}
                >Skills</a
              >
              <p>Open installed-skill and skill-pack sections; compact tables and an inline registration form.</p>
              <a data-design-view="files" href=${i.stateToUrl({view:"files",scope:i.scope()})}
                >Files</a
              >
              <p>Search in the header, flat upload toolbar, then scopes or files with metadata.</p>
              <a data-design-view="history" href=${i.stateToUrl({view:"history",scope:i.scope()})}
                >Sessions</a
              >
              <p>Two-way sort toggle, named environments, and a separately titled conversation list.</p>
              <a data-design-view="audit" href=${i.stateToUrl({view:"audit",scope:i.scope()})}
                >Audit</a
              >
              ·
              <a data-design-view="egress" href=${i.stateToUrl({view:"egress",scope:i.scope()})}
                >Egress</a
              >
              <p>Filters above plain tables; headers stay transparent and regular-weight.</p>
            </div>`,!0),c("Responsive behavior","Page-level rules",l`<ul class="design-rules">
              <li>At ≤900px, the sidebar becomes horizontal navigation.</li>
              <li>
                At ≤640px, Skills and Files search uses the full row; dense rows allow more height and Files metadata
                wraps below the name.
              </li>
              <li>Wide tables scroll inside .tablewrap. Never force the entire document wider than the viewport.</li>
              <li>
                Keep all actions and metadata available on mobile. Use wrapping or local scrolling rather than hiding
                content.
              </li>
              <li>Sidebar scrolling is contained; reaching its end must not scroll the main page.</li>
            </ul>`,!0)]),A("Artifact and reporting patterns","Compositions from the recent redesigns. Shared helpers render the lists; the form and report examples are local demonstrations.",[c("Scope list","denseList() \xB7 shared Skills / Files row styles \xB7 Enter or click selects a demo row",l`<div id="design-scope-list">${$()}</div>
              <p class="hint" id="design-scope-status" role="status">${s.scopeStatus}</p>`,!0),c("File list and upload toolbar","denseList() + fileThumb() \xB7 .file-upload \xB7 visual upload example, no network requests",l`<div class="file-upload">
                <div class="file-upload-actions">
                  <button
                    type="button"
                    class="primary upload-button"
                    id="design-upload"
                    @click=${()=>n({fileStatus:"On Files, this opens the file picker. This example does not upload files."})}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg
                    ><span>Upload</span>
                  </button>
                </div>
              </div>
              <div id="design-file-list">${b()}</div>
              <p class="hint" id="design-file-status" role="status">${s.fileStatus}</p>`,!0),c("Skill-pack registration",".pack-register \xB7 shared Skills styles \xB7 local form demonstration",l`<div class="pack-register">
                <input
                  type="url"
                  aria-label="Example skill repository"
                  placeholder="https://github.com/example/skills"
                /><button
                  type="button"
                  id="design-register"
                  @click=${()=>n({packStatus:"Example registered locally. No repository was fetched."})}
                >
                  Register</button
                ><button
                  type="button"
                  class="linkish"
                  id="design-advanced"
                  @click=${()=>n({advanced:!s.advanced})}
                  aria-expanded=${String(s.advanced)}
                  aria-controls="design-pack-advanced"
                >
                  Advanced
                </button>
              </div>
              <div class=${s.advanced?"pack-adv":"pack-adv hidden"} id="design-pack-advanced">
                <div>
                  <label for="design-pack-name">Name</label
                  ><input id="design-pack-name" type="text" placeholder="Team skills" />
                </div>
                <div>
                  <label for="design-pack-ref">Ref</label><input id="design-pack-ref" type="text" placeholder="main" />
                </div>
                <div>
                  <label for="design-pack-path">Path</label
                  ><input id="design-pack-path" type="text" placeholder="skills/" />
                </div>
              </div>
              <p class="hint" id="design-pack-status" role="status">${s.packStatus}</p>`,!0),c("Open report section","Authored Metrics / Audit / Egress composition \xB7 statline() + shared table controls",l`<section class="design-open-section">
              <h3>Activity summary</h3>
              <p class="hint">Keep descriptions beside the section they explain.</p>
              <div id="design-metrics-summary">
                <div class="statline">152 requests · 2 scopes · Last 24 hours</div>
              </div>
              <div class="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>Requests</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Example team</td>
                      <td>128</td>
                      <td><span class="badge ok">Healthy</span></td>
                    </tr>
                    <tr>
                      <td>Research</td>
                      <td>24</td>
                      <td><span class="badge muted">Idle</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>`,!0)]),A("Actions","32px controls with a 6px radius. Primary actions use the dark blue accent.",[c("Buttons","button \xB7 .primary \xB7 .danger",l`<button type="button" class="primary">Apply</button><button type="button">Add item</button
            ><button type="button" class="danger">Delete</button><button type="button" disabled>Disabled</button
            ><button type="button" class="primary" disabled>Apply</button>`),c("Quiet actions",".viewlink \xB7 .icon-button",l`<button type="button" class="viewlink">View history ›</button
            ><button type="button" class="icon-button" aria-label="Remove example">×</button>`),c("Save feedback",".foot \xB7 .status \xB7 native input events",l`<section class="card">
            <div class="head">
              <h2>Example setting</h2>
              <p>Edit the name to try unsaved and saved states.</p>
            </div>
            <div class="body">
              <label for="design-name">Display name</label
              ><input
                id="design-name"
                type="text"
                .value=${s.name}
                @input=${y=>n({name:y.target.value,nameSaved:!1})}
              />
            </div>
            <div class="foot">
              <span class="status" id="design-status" role="status">${f()}</span
              ><button
                class="primary"
                type="button"
                id="design-apply"
                ?disabled=${s.name===s.savedName}
                @click=${()=>n({savedName:s.name,nameSaved:!0})}
              >
                Apply
              </button>
            </div>
          </section>`,!0)]),A("Two-way toggle","Choose one of two mutually exclusive options. Tab to focus; use arrow keys to switch.",[c("Segmented choice","twoWayToggle({ label, options, value, onChange, disabled }) \xB7 shared radio group",l`<div id="design-two-way-toggle">${u}</div>
              <p class="hint" id="design-two-way-status" role="status">${s.toggleStatus}</p>`,!0),c("Disabled","The same component with disabled: true",l`<div id="design-two-way-disabled">${h}</div>`)]),A("Search","A transparent background, subtle border, search icon, and clear action. Focus uses the shared dark blue accent.",[c("Search field","searchField() \xB7 shared with Slack and page toolbar searches",l`<div id="design-search">${o}</div>
              <p class="hint" id="design-search-status" role="status">${s.searchStatus}</p>`,!0),c("Populated and disabled","The same component with value and disabled options",l`<div id="design-search-filled">${p}</div>
              <div id="design-search-disabled">${r}</div>`,!0)]),A("Fields","Shared sizing, labels, hints, focus rings, validation, and disabled states.",[c("Text fields","input \xB7 label \xB7 .hint",l`<label for="design-text">Client ID</label
            ><input id="design-text" type="text" placeholder="Enter a client ID" aria-describedby="design-text-hint" />
            <p class="hint" id="design-text-hint">A label stays visible when the field has a value.</p>
            <label for="design-number">Limit</label><input id="design-number" type="number" value="10" /><label
              for="design-disabled"
              >Inherited value</label
            ><input id="design-disabled" type="text" disabled value="Organization default" /><label for="design-invalid"
              >Required value</label
            ><input id="design-invalid" type="text" aria-invalid="true" aria-describedby="design-error" />
            <p class="status err" id="design-error">Enter a value to continue.</p>`,!0),c("Dropdown","select \u2192 shared .dd accessible dropdown",l`<label for="design-select">Scope</label
            ><select id="design-select">
              <option>Organization</option>
              <option>Team</option>
              <option>Personal</option>
            </select>`,!0),c("Multiline","textarea \xB7 same field border and label",l`<label for="design-notes">Instructions</label
            ><textarea id="design-notes" rows="3" placeholder="Write instructions…"></textarea>`,!0),c("Choices",".choice-stack \xB7 .posture-choice",l`<div class="choice-stack">
            <label class="posture-choice"
              ><input type="radio" name="design-choice" checked /><span
                ><strong>Automatic</strong><small>Review activity when needed.</small></span
              ></label
            ><label class="posture-choice"
              ><input type="radio" name="design-choice" /><span
                ><strong>Always review</strong><small>Review every request.</small></span
              ></label
            >
          </div>`,!0),c("Switch & checkbox",".setting-toggle \xB7 .setting-switch \xB7 input[type=checkbox]",l`<label class="setting-toggle"
              ><input type="checkbox" checked /><span class="setting-switch" aria-hidden="true"></span
              ><span>Enable feature</span></label
            ><label><input type="checkbox" /> Include optional details</label>`,!0)]),A("Sections & lists","Open sections separated by rules, with the same headings, descriptions, and row actions.",[c("Settings section",".card > .head / .body / .foot",l`<section class="card">
              <div class="head">
                <h2>Section title</h2>
                <p>Explain what the setting changes.</p>
              </div>
              <div class="body">
                <label for="design-section-field">Setting label</label
                ><input id="design-section-field" type="text" value="Default value" />
              </div>
              <div class="foot">
                <span class="status">No changes</span><button class="primary" type="button" disabled>Apply</button>
              </div>
            </section>`,!0),c("List row",".credential-row \xB7 .credential-title \xB7 .credential-actions",l`<div class="credential-row">
              <div class="credential-main">
                <div class="credential-title">
                  <strong>Example service</strong><span class="credential-slug">example</span>
                </div>
                <p class="hint">Available to the organization</p>
              </div>
              <div class="credential-actions">
                <button type="button">Edit</button><button type="button" class="danger">Delete</button>
              </div>
            </div>`,!0),c("Model chip",".model-chip \xB7 removable item",l`${s.chip?l`<div class="model-chip"><span>Example model</span><button type="button" id="design-remove-chip" aria-label="Remove example model" @click=${()=>n({chip:!1})}>×</button></div>`:v}<span
                class="hint"
                id="design-chip-status"
                role="status"
                >${s.chip?"":"Example model removed"}</span
              >`),c("Badges & feedback",".badge \xB7 .status \xB7 semantic colors",l`<span class="badge muted">Inherited</span><span class="badge ok">Enabled</span
              ><span class="badge warn">Needs review</span><span class="badge err">Failed</span
              ><span class="status ok">Saved</span><span class="status err">Save failed</span>`),c("Empty state",".empty",l`<div class="empty">No items yet. Add an item to get started.</div>`,!0)]),A("Dialogs","The same controls in a focused, keyboard-accessible dialog. Escape closes it and returns focus.",[c("Review dialog","dialog.review-dialog \xB7 shared fields and actions",l`<button type="button" id="design-dialog-open" @click=${()=>a()?.showModal()}>
                Open example dialog
              </button>
              <dialog class="review-dialog" id="design-dialog" aria-labelledby="design-dialog-title">
                <div class="review-dialog-head">
                  <h2 id="design-dialog-title">Example dialog</h2>
                  <p>Try the shared controls without changing any settings.</p>
                </div>
                <div class="review-dialog-body">
                  <label for="design-dialog-field">Display name</label
                  ><input id="design-dialog-field" type="text" value="Example" />
                </div>
                <div class="review-dialog-foot">
                  <button type="button" id="design-dialog-close" @click=${()=>a()?.close()}>Cancel</button
                  ><button type="button" class="primary" id="design-dialog-done" @click=${()=>a()?.close()}>
                    Done
                  </button>
                </div>
              </dialog>`)]),A("Tables","13px cells, quiet headers, consistent padding, and scrolling inside the table on small screens.",[c("Data table",".tablewrap > table \xB7 th \xB7 td",l`<div class="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Access</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Alex Example</td>
                    <td>Organization</td>
                    <td><span class="badge ok">Active</span></td>
                    <td><button type="button">Edit</button></td>
                  </tr>
                  <tr>
                    <td>Sam Example</td>
                    <td>Team</td>
                    <td><span class="badge muted">Invited</span></td>
                    <td><button type="button" disabled>Edit</button></td>
                  </tr>
                </tbody>
              </table>
            </div>`,!0)])];t(l`${le[0]}
        <nav class="design-contents" aria-label="Design system sections">
          ${m.map(y=>l`<a href=${"#"+re(y)}>${y}</a>`)}
        </nav>
        ${le.slice(1)}`)}E(),i.initCustomDropdowns(e)}var We="/admin";function Ve({placeholder:i="Search\u2026",onInput:e=()=>{},value:t="",disabled:s=!1}){let n=document.createElement("div");n.className="shell-search admin-search";let a=document.createElement("input");a.type="search",a.placeholder=i,a.setAttribute("aria-label",i.replace(/[…]+$/,"")),a.spellcheck=!1,a.setAttribute("autocapitalize","none"),a.value=t,a.disabled=s,a.oninput=()=>e(a.value),n.appendChild(a);let o=document.createElement("span");o.className="admin-search-icon",o.setAttribute("aria-hidden","true"),o.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';let p=document.createElement("button");return p.type="button",p.className="icon-button admin-search-clear",p.setAttribute("aria-label","Clear search"),p.textContent="\xD7",p.disabled=s,p.onclick=()=>{a.value="",e(""),a.focus()},n.append(o,p),n}var Ge=0;function Je({label:i,options:e,value:t,onChange:s,disabled:n=!1}){if(e.length!==2||e[0].value===e[1].value)throw new Error("A two-way toggle needs two distinct options.");let a=document.createElement("fieldset");a.className="two-way-toggle",a.disabled=n;let o=document.createElement("legend");o.textContent=i,a.appendChild(o);let p="two-way-toggle-"+ ++Ge;return e.forEach(r=>{let g=document.createElement("label"),u=document.createElement("input");u.type="radio",u.name=p,u.value=r.value,u.checked=r.value===t,u.onchange=()=>{u.checked&&s(r.value)};let h=document.createElement("span");h.textContent=r.label,g.append(u,h),a.appendChild(g)}),a}var Qe='<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',V=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value"),w=null,Ye=0;function D(i){if(!i)return;i.classList.remove("open");let e=i.querySelector(".dd-btn");e?.setAttribute("aria-expanded","false"),e?.removeAttribute("aria-activedescendant")}function Te(i){if(!(i instanceof HTMLSelectElement)||i.dataset.ddHost||i.hasAttribute("hidden")||i.multiple||i.size>1)return;i.dataset.ddHost="1";let e=document.createElement("div");e.className="dd",i.getAttribute("style")&&e.setAttribute("style",i.getAttribute("style"));let t=document.createElement("button");t.type="button",t.setAttribute("aria-haspopup","listbox"),t.setAttribute("aria-expanded","false");let s=document.createElement("span");t.appendChild(s),t.insertAdjacentHTML("beforeend",Qe);let n=document.createElement("div");n.className="dd-menu",n.setAttribute("role","listbox"),n.id="dd-menu-"+ ++Ye,t.setAttribute("aria-controls",n.id),e.append(t,n),i.after(e);let a=-1,o=()=>{let d=i.selectedOptions[0];s.textContent=d?d.textContent:"";let b=i.getAttribute("aria-label")||i.labels?.[0]?.textContent?.trim()||"";t.setAttribute("aria-label",b?b+": "+s.textContent:s.textContent),t.className=["dd-btn",...i.classList].join(" "),t.disabled=i.disabled},p=d=>{V.get.call(i)!==d&&(V.set.call(i,d),o(),i.dispatchEvent(new Event("input",{bubbles:!0})),i.dispatchEvent(new Event("change",{bubbles:!0})))},r=()=>Array.from(i.options).filter(d=>!d.disabled),g=d=>{let b=Array.from(n.querySelectorAll(".dd-item:not(.dis)"));if(!b.length){a=-1;return}a=Math.max(0,Math.min(b.length-1,d)),b.forEach((f,E)=>{f.classList.toggle("active",E===a),E===a&&(t.setAttribute("aria-activedescendant",f.id),f.scrollIntoView({block:"nearest"}))})},u=()=>{n.textContent="",a=-1;let d=0;Array.from(i.options).forEach(b=>{let f=document.createElement("div");f.className="dd-item"+(b.selected?" sel":"")+(b.disabled?" dis":""),f.id=n.id+"-option-"+n.children.length,f.setAttribute("role","option"),b.selected&&f.setAttribute("aria-selected","true"),f.textContent=b.textContent,b.disabled||(b.selected&&(a=d),d+=1),f.onclick=E=>{E.stopPropagation(),!b.disabled&&(D(e),w=null,p(b.value),t.focus())},n.appendChild(f)}),g(a)},h=()=>{i.disabled||(w&&w!==e&&D(w),u(),e.classList.add("open"),t.setAttribute("aria-expanded","true"),w=e)},$=()=>{let d=e.classList.contains("open");D(w),w=null,d||h()};t.onclick=d=>{d.stopPropagation(),$()},t.onkeydown=d=>{if(d.key==="Escape"){D(e),w=null,d.preventDefault();return}if(d.key==="Enter"){if(d.preventDefault(),!e.classList.contains("open")){h();return}let f=r()[a];f&&p(f.value),D(e),w=null;return}if(!(d.key!=="ArrowDown"&&d.key!=="ArrowUp"||(d.preventDefault(),!r().length))){if(!e.classList.contains("open")){h();return}g(a+(d.key==="ArrowDown"?1:-1))}},Object.defineProperty(i,"value",{get(){return V.get.call(i)},set(d){V.set.call(i,d),o()}}),new MutationObserver(()=>{o(),e.classList.contains("open")&&u()}).observe(i,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["class","disabled","label","selected","value"]}),i.addEventListener("change",o),o()}document.addEventListener("click",()=>{D(w),w=null});function Ze(i){i instanceof Element&&(i instanceof HTMLSelectElement&&Te(i),i.querySelectorAll("select").forEach(e=>Te(e)))}function Xe(i){let e=String(i||""),t=e.includes(".")?e.split(".").pop():"";return t?"."+t.toLowerCase():"file"}function et(i){let e=document.createElement("span");e.className="file-thumb";let t=Xe(i.name||i.path);if(e.textContent=t==="file"?"":t.slice(1),i.openable&&/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(i.mimetype||""))if(!i.size||i.size<=200*1024){let s=document.createElement("img");s.loading="lazy",s.decoding="async",s.alt="",s.src=We+"/api/files/download?id="+encodeURIComponent(i.id),s.onerror=()=>s.remove(),e.appendChild(s)}else e.textContent="img",e.title="Large image. Click to preview full size";return e}Ce({stateToUrl:i=>"/admin/"+i.view,scope:()=>"org:acme",searchField:Ve,twoWayToggle:Je,fileThumb:et,initCustomDropdowns:Ze});document.getElementById("theme").onclick=()=>document.documentElement.classList.toggle("dark");})();
