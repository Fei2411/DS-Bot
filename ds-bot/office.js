#!/usr/bin/env node
// Generated from src/office by `npm run build` (scripts/build-client.mjs). Do not edit by hand.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/@xmldom/xmldom/lib/conventions.js
var require_conventions = __commonJS({
  "node_modules/@xmldom/xmldom/lib/conventions.js"(exports) {
    "use strict";
    function find(list, predicate, ac) {
      if (ac === void 0) {
        ac = Array.prototype;
      }
      if (list && typeof ac.find === "function") {
        return ac.find.call(list, predicate);
      }
      for (var i = 0; i < list.length; i++) {
        if (hasOwn(list, i)) {
          var item = list[i];
          if (predicate.call(void 0, item, i, list)) {
            return item;
          }
        }
      }
    }
    function freeze(object, oc) {
      if (oc === void 0) {
        oc = Object;
      }
      if (oc && typeof oc.getOwnPropertyDescriptors === "function") {
        object = oc.create(null, oc.getOwnPropertyDescriptors(object));
      }
      return oc && typeof oc.freeze === "function" ? oc.freeze(object) : object;
    }
    function hasOwn(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }
    function assign(target, source) {
      if (target === null || typeof target !== "object") {
        throw new TypeError("target is not an object");
      }
      for (var key in source) {
        if (hasOwn(source, key)) {
          target[key] = source[key];
        }
      }
      return target;
    }
    var HTML_BOOLEAN_ATTRIBUTES = freeze({
      allowfullscreen: true,
      async: true,
      autofocus: true,
      autoplay: true,
      checked: true,
      controls: true,
      default: true,
      defer: true,
      disabled: true,
      formnovalidate: true,
      hidden: true,
      ismap: true,
      itemscope: true,
      loop: true,
      multiple: true,
      muted: true,
      nomodule: true,
      novalidate: true,
      open: true,
      playsinline: true,
      readonly: true,
      required: true,
      reversed: true,
      selected: true
    });
    function isHTMLBooleanAttribute(name) {
      return hasOwn(HTML_BOOLEAN_ATTRIBUTES, name.toLowerCase());
    }
    var HTML_VOID_ELEMENTS = freeze({
      area: true,
      base: true,
      br: true,
      col: true,
      embed: true,
      hr: true,
      img: true,
      input: true,
      link: true,
      meta: true,
      param: true,
      source: true,
      track: true,
      wbr: true
    });
    function isHTMLVoidElement(tagName) {
      return hasOwn(HTML_VOID_ELEMENTS, tagName.toLowerCase());
    }
    var HTML_RAW_TEXT_ELEMENTS = freeze({
      script: false,
      style: false,
      textarea: true,
      title: true
    });
    function isHTMLRawTextElement(tagName) {
      var key = tagName.toLowerCase();
      return hasOwn(HTML_RAW_TEXT_ELEMENTS, key) && !HTML_RAW_TEXT_ELEMENTS[key];
    }
    function isHTMLEscapableRawTextElement(tagName) {
      var key = tagName.toLowerCase();
      return hasOwn(HTML_RAW_TEXT_ELEMENTS, key) && HTML_RAW_TEXT_ELEMENTS[key];
    }
    function isHTMLMimeType(mimeType) {
      return mimeType === MIME_TYPE.HTML;
    }
    function hasDefaultHTMLNamespace(mimeType) {
      return isHTMLMimeType(mimeType) || mimeType === MIME_TYPE.XML_XHTML_APPLICATION;
    }
    var MIME_TYPE = freeze({
      /**
       * `text/html`, the only mime type that triggers treating an XML document as HTML.
       *
       * @see https://www.iana.org/assignments/media-types/text/html IANA MimeType registration
       * @see https://en.wikipedia.org/wiki/HTML Wikipedia
       * @see https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString MDN
       * @see https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html#dom-domparser-parsefromstring
       *      WHATWG HTML Spec
       */
      HTML: "text/html",
      /**
       * `application/xml`, the standard mime type for XML documents.
       *
       * @see https://www.iana.org/assignments/media-types/application/xml IANA MimeType
       *      registration
       * @see https://tools.ietf.org/html/rfc7303#section-9.1 RFC 7303
       * @see https://en.wikipedia.org/wiki/XML_and_MIME Wikipedia
       */
      XML_APPLICATION: "application/xml",
      /**
       * `text/xml`, an alias for `application/xml`.
       *
       * @see https://tools.ietf.org/html/rfc7303#section-9.2 RFC 7303
       * @see https://www.iana.org/assignments/media-types/text/xml IANA MimeType registration
       * @see https://en.wikipedia.org/wiki/XML_and_MIME Wikipedia
       */
      XML_TEXT: "text/xml",
      /**
       * `application/xhtml+xml`, indicates an XML document that has the default HTML namespace,
       * but is parsed as an XML document.
       *
       * @see https://www.iana.org/assignments/media-types/application/xhtml+xml IANA MimeType
       *      registration
       * @see https://dom.spec.whatwg.org/#dom-domimplementation-createdocument WHATWG DOM Spec
       * @see https://en.wikipedia.org/wiki/XHTML Wikipedia
       */
      XML_XHTML_APPLICATION: "application/xhtml+xml",
      /**
       * `image/svg+xml`,
       *
       * @see https://www.iana.org/assignments/media-types/image/svg+xml IANA MimeType registration
       * @see https://www.w3.org/TR/SVG11/ W3C SVG 1.1
       * @see https://en.wikipedia.org/wiki/Scalable_Vector_Graphics Wikipedia
       */
      XML_SVG_IMAGE: "image/svg+xml"
    });
    var _MIME_TYPES = Object.keys(MIME_TYPE).map(function(key) {
      return MIME_TYPE[key];
    });
    function isValidMimeType(mimeType) {
      return _MIME_TYPES.indexOf(mimeType) > -1;
    }
    var NAMESPACE = freeze({
      /**
       * The XHTML namespace.
       *
       * @see http://www.w3.org/1999/xhtml
       */
      HTML: "http://www.w3.org/1999/xhtml",
      /**
       * The SVG namespace.
       *
       * @see http://www.w3.org/2000/svg
       */
      SVG: "http://www.w3.org/2000/svg",
      /**
       * The `xml:` namespace.
       *
       * @see http://www.w3.org/XML/1998/namespace
       */
      XML: "http://www.w3.org/XML/1998/namespace",
      /**
       * The `xmlns:` namespace.
       *
       * @see https://www.w3.org/2000/xmlns/
       */
      XMLNS: "http://www.w3.org/2000/xmlns/"
    });
    exports.assign = assign;
    exports.find = find;
    exports.freeze = freeze;
    exports.HTML_BOOLEAN_ATTRIBUTES = HTML_BOOLEAN_ATTRIBUTES;
    exports.HTML_RAW_TEXT_ELEMENTS = HTML_RAW_TEXT_ELEMENTS;
    exports.HTML_VOID_ELEMENTS = HTML_VOID_ELEMENTS;
    exports.hasDefaultHTMLNamespace = hasDefaultHTMLNamespace;
    exports.hasOwn = hasOwn;
    exports.isHTMLBooleanAttribute = isHTMLBooleanAttribute;
    exports.isHTMLRawTextElement = isHTMLRawTextElement;
    exports.isHTMLEscapableRawTextElement = isHTMLEscapableRawTextElement;
    exports.isHTMLMimeType = isHTMLMimeType;
    exports.isHTMLVoidElement = isHTMLVoidElement;
    exports.isValidMimeType = isValidMimeType;
    exports.MIME_TYPE = MIME_TYPE;
    exports.NAMESPACE = NAMESPACE;
  }
});

// node_modules/@xmldom/xmldom/lib/errors.js
var require_errors = __commonJS({
  "node_modules/@xmldom/xmldom/lib/errors.js"(exports) {
    "use strict";
    var conventions = require_conventions();
    function extendError(constructor, writableName) {
      constructor.prototype = Object.create(Error.prototype, {
        constructor: { value: constructor },
        name: { value: constructor.name, enumerable: true, writable: writableName }
      });
    }
    var DOMExceptionName = conventions.freeze({
      /**
       * the default value as defined by the spec
       */
      Error: "Error",
      /**
       * @deprecated
       * Use RangeError instead.
       */
      IndexSizeError: "IndexSizeError",
      /**
       * @deprecated
       * Just to match the related static code, not part of the spec.
       */
      DomstringSizeError: "DomstringSizeError",
      HierarchyRequestError: "HierarchyRequestError",
      WrongDocumentError: "WrongDocumentError",
      InvalidCharacterError: "InvalidCharacterError",
      /**
       * @deprecated
       * Just to match the related static code, not part of the spec.
       */
      NoDataAllowedError: "NoDataAllowedError",
      NoModificationAllowedError: "NoModificationAllowedError",
      NotFoundError: "NotFoundError",
      NotSupportedError: "NotSupportedError",
      InUseAttributeError: "InUseAttributeError",
      InvalidStateError: "InvalidStateError",
      SyntaxError: "SyntaxError",
      InvalidModificationError: "InvalidModificationError",
      NamespaceError: "NamespaceError",
      /**
       * @deprecated
       * Use TypeError for invalid arguments,
       * "NotSupportedError" DOMException for unsupported operations,
       * and "NotAllowedError" DOMException for denied requests instead.
       */
      InvalidAccessError: "InvalidAccessError",
      /**
       * @deprecated
       * Just to match the related static code, not part of the spec.
       */
      ValidationError: "ValidationError",
      /**
       * @deprecated
       * Use TypeError instead.
       */
      TypeMismatchError: "TypeMismatchError",
      SecurityError: "SecurityError",
      NetworkError: "NetworkError",
      AbortError: "AbortError",
      /**
       * @deprecated
       * Just to match the related static code, not part of the spec.
       */
      URLMismatchError: "URLMismatchError",
      QuotaExceededError: "QuotaExceededError",
      TimeoutError: "TimeoutError",
      InvalidNodeTypeError: "InvalidNodeTypeError",
      DataCloneError: "DataCloneError",
      EncodingError: "EncodingError",
      NotReadableError: "NotReadableError",
      UnknownError: "UnknownError",
      ConstraintError: "ConstraintError",
      DataError: "DataError",
      TransactionInactiveError: "TransactionInactiveError",
      ReadOnlyError: "ReadOnlyError",
      VersionError: "VersionError",
      OperationError: "OperationError",
      NotAllowedError: "NotAllowedError",
      OptOutError: "OptOutError"
    });
    var DOMExceptionNames = Object.keys(DOMExceptionName);
    function isValidDomExceptionCode(value) {
      return typeof value === "number" && value >= 1 && value <= 25;
    }
    function endsWithError(value) {
      return typeof value === "string" && value.substring(value.length - DOMExceptionName.Error.length) === DOMExceptionName.Error;
    }
    function DOMException(messageOrCode, nameOrMessage) {
      if (isValidDomExceptionCode(messageOrCode)) {
        this.name = DOMExceptionNames[messageOrCode];
        this.message = nameOrMessage || "";
      } else {
        this.message = messageOrCode;
        this.name = endsWithError(nameOrMessage) ? nameOrMessage : DOMExceptionName.Error;
      }
      if (Error.captureStackTrace) Error.captureStackTrace(this, DOMException);
    }
    extendError(DOMException, true);
    Object.defineProperties(DOMException.prototype, {
      code: {
        enumerable: true,
        get: function() {
          var code = DOMExceptionNames.indexOf(this.name);
          if (isValidDomExceptionCode(code)) return code;
          return 0;
        }
      }
    });
    var ExceptionCode = {
      INDEX_SIZE_ERR: 1,
      DOMSTRING_SIZE_ERR: 2,
      HIERARCHY_REQUEST_ERR: 3,
      WRONG_DOCUMENT_ERR: 4,
      INVALID_CHARACTER_ERR: 5,
      NO_DATA_ALLOWED_ERR: 6,
      NO_MODIFICATION_ALLOWED_ERR: 7,
      NOT_FOUND_ERR: 8,
      NOT_SUPPORTED_ERR: 9,
      INUSE_ATTRIBUTE_ERR: 10,
      INVALID_STATE_ERR: 11,
      SYNTAX_ERR: 12,
      INVALID_MODIFICATION_ERR: 13,
      NAMESPACE_ERR: 14,
      INVALID_ACCESS_ERR: 15,
      VALIDATION_ERR: 16,
      TYPE_MISMATCH_ERR: 17,
      SECURITY_ERR: 18,
      NETWORK_ERR: 19,
      ABORT_ERR: 20,
      URL_MISMATCH_ERR: 21,
      QUOTA_EXCEEDED_ERR: 22,
      TIMEOUT_ERR: 23,
      INVALID_NODE_TYPE_ERR: 24,
      DATA_CLONE_ERR: 25
    };
    var entries = Object.entries(ExceptionCode);
    for (i = 0; i < entries.length; i++) {
      key = entries[i][0];
      DOMException[key] = entries[i][1];
    }
    var key;
    var i;
    function ParseError(message, locator, cause) {
      this.message = message;
      this.locator = locator;
      this.cause = cause;
      if (Error.captureStackTrace) Error.captureStackTrace(this, ParseError);
    }
    extendError(ParseError);
    exports.DOMException = DOMException;
    exports.DOMExceptionName = DOMExceptionName;
    exports.ExceptionCode = ExceptionCode;
    exports.ParseError = ParseError;
  }
});

// node_modules/@xmldom/xmldom/lib/grammar.js
var require_grammar = __commonJS({
  "node_modules/@xmldom/xmldom/lib/grammar.js"(exports) {
    "use strict";
    function detectUnicodeSupport(RegExpImpl) {
      try {
        if (typeof RegExpImpl !== "function") {
          RegExpImpl = RegExp;
        }
        var match = new RegExpImpl("𝌆", "u").exec("𝌆");
        return !!match && match[0].length === 2;
      } catch (error) {
      }
      return false;
    }
    var UNICODE_SUPPORT = detectUnicodeSupport();
    function chars(regexp) {
      if (regexp.source[0] !== "[") {
        throw new Error(regexp + " can not be used with chars");
      }
      return regexp.source.slice(1, regexp.source.lastIndexOf("]"));
    }
    function chars_without(regexp, search) {
      if (regexp.source[0] !== "[") {
        throw new Error("/" + regexp.source + "/ can not be used with chars_without");
      }
      if (!search || typeof search !== "string") {
        throw new Error(JSON.stringify(search) + " is not a valid search");
      }
      if (regexp.source.indexOf(search) === -1) {
        throw new Error('"' + search + '" is not is /' + regexp.source + "/");
      }
      if (search === "-" && regexp.source.indexOf(search) !== 1) {
        throw new Error('"' + search + '" is not at the first postion of /' + regexp.source + "/");
      }
      return new RegExp(regexp.source.replace(search, ""), UNICODE_SUPPORT ? "u" : "");
    }
    function reg(args) {
      var self = this;
      return new RegExp(
        Array.prototype.slice.call(arguments).map(function(part) {
          var isStr = typeof part === "string";
          if (isStr && self === void 0 && part === "|") {
            throw new Error("use regg instead of reg to wrap expressions with `|`!");
          }
          return isStr ? part : part.source;
        }).join(""),
        UNICODE_SUPPORT ? "u" : ""
      );
    }
    function regg(args) {
      if (arguments.length === 0) {
        throw new Error("no parameters provided");
      }
      return reg.apply(regg, ["(?:"].concat(Array.prototype.slice.call(arguments), [")"]));
    }
    var UNICODE_REPLACEMENT_CHARACTER = "�";
    var Char = /[-\x09\x0A\x0D\x20-\x2C\x2E-\uD7FF\uE000-\uFFFD]/;
    if (UNICODE_SUPPORT) {
      Char = reg("[", chars(Char), "\\u{10000}-\\u{10FFFF}", "]");
    }
    var InvalidChar = new RegExp("[^" + chars(Char) + "]", UNICODE_SUPPORT ? "u" : "");
    var _SChar = /[\x20\x09\x0D\x0A]/;
    var SChar_s = chars(_SChar);
    var S = reg(_SChar, "+");
    var S_OPT = reg(_SChar, "*");
    var NameStartChar = /[:_a-zA-Z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;
    if (UNICODE_SUPPORT) {
      NameStartChar = reg("[", chars(NameStartChar), "\\u{10000}-\\u{10FFFF}", "]");
    }
    var NameStartChar_s = chars(NameStartChar);
    var NameChar = reg("[", NameStartChar_s, chars(/[-.0-9\xB7]/), chars(/[\u0300-\u036F\u203F-\u2040]/), "]");
    var Name = reg(NameStartChar, NameChar, "*");
    var Name_exact = reg("^", Name, "$");
    var Nmtoken = reg(NameChar, "+");
    var EntityRef = reg("&", Name, ";");
    var CharRef = regg(/&#[0-9]+;|&#x[0-9a-fA-F]+;/);
    var Reference = regg(EntityRef, "|", CharRef);
    var PEReference = reg("%", Name, ";");
    var EntityValue = regg(
      reg('"', regg(/[^%&"]/, "|", PEReference, "|", Reference), "*", '"'),
      "|",
      reg("'", regg(/[^%&']/, "|", PEReference, "|", Reference), "*", "'")
    );
    var AttValue = regg('"', regg(/[^<&"]/, "|", Reference), "*", '"', "|", "'", regg(/[^<&']/, "|", Reference), "*", "'");
    var NCNameStartChar = chars_without(NameStartChar, ":");
    var NCNameChar = chars_without(NameChar, ":");
    var NCName = reg(NCNameStartChar, NCNameChar, "*");
    var NCName_exact = reg("^", NCName, "$");
    var QName = reg(NCName, regg(":", NCName), "?");
    var QName_exact = reg("^", QName, "$");
    var QName_group = reg("(", QName, ")");
    var SystemLiteral = regg(/"[^"]*"|'[^']*'/);
    var PI = reg(/^<\?/, "(", Name, ")", regg(S, "(?!", _SChar, ")(", Char, "*?)"), "?", /\?>/);
    var PubidChar = /[\x20\x0D\x0Aa-zA-Z0-9-'()+,./:=?;!*#@$_%]/;
    var PubidLiteral = regg('"', PubidChar, '*"', "|", "'", chars_without(PubidChar, "'"), "*'");
    var COMMENT_START = "<!--";
    var COMMENT_END = "-->";
    var Comment = reg(COMMENT_START, regg(chars_without(Char, "-"), "|", reg("-", chars_without(Char, "-"))), "*", COMMENT_END);
    var PCDATA = "#PCDATA";
    var Mixed = regg(
      reg(/\(/, S_OPT, PCDATA, regg(S_OPT, /\|/, S_OPT, QName), "*", S_OPT, /\)\*/),
      "|",
      reg(/\(/, S_OPT, PCDATA, S_OPT, /\)/)
    );
    var _children_quantity = /[?*+]?/;
    var children = reg(
      /\([^>]+\)/,
      _children_quantity
      /*regg(choice, '|', seq), _children_quantity*/
    );
    var contentspec = regg("EMPTY", "|", "ANY", "|", Mixed, "|", children);
    var ELEMENTDECL_START = "<!ELEMENT";
    var elementdecl = reg(ELEMENTDECL_START, S, regg(QName, "|", PEReference), S, regg(contentspec, "|", PEReference), S_OPT, ">");
    var NotationType = reg("NOTATION", S, /\(/, S_OPT, Name, regg(S_OPT, /\|/, S_OPT, Name), "*", S_OPT, /\)/);
    var Enumeration = reg(/\(/, S_OPT, Nmtoken, regg(S_OPT, /\|/, S_OPT, Nmtoken), "*", S_OPT, /\)/);
    var EnumeratedType = regg(NotationType, "|", Enumeration);
    var AttType = regg(/CDATA|ID|IDREF|IDREFS|ENTITY|ENTITIES|NMTOKEN|NMTOKENS/, "|", EnumeratedType);
    var DefaultDecl = regg(/#REQUIRED|#IMPLIED/, "|", regg(regg("#FIXED", S), "?", AttValue));
    var AttDef = regg(S, Name, S, AttType, S, DefaultDecl);
    var ATTLIST_DECL_START = "<!ATTLIST";
    var AttlistDecl = reg(ATTLIST_DECL_START, S, Name, AttDef, "*", S_OPT, ">");
    var ABOUT_LEGACY_COMPAT = "about:legacy-compat";
    var ABOUT_LEGACY_COMPAT_SystemLiteral = regg('"' + ABOUT_LEGACY_COMPAT + '"', "|", "'" + ABOUT_LEGACY_COMPAT + "'");
    var SYSTEM = "SYSTEM";
    var PUBLIC = "PUBLIC";
    var ExternalID = regg(regg(SYSTEM, S, SystemLiteral), "|", regg(PUBLIC, S, PubidLiteral, S, SystemLiteral));
    var ExternalID_match = reg(
      "^",
      regg(
        regg(SYSTEM, S, "(?<SystemLiteralOnly>", SystemLiteral, ")"),
        "|",
        regg(PUBLIC, S, "(?<PubidLiteral>", PubidLiteral, ")", S, "(?<SystemLiteral>", SystemLiteral, ")")
      )
    );
    var PubidLiteral_match = reg("^", PubidLiteral, "$");
    var SystemLiteral_match = reg("^", SystemLiteral, "$");
    var NDataDecl = regg(S, "NDATA", S, Name);
    var EntityDef = regg(EntityValue, "|", regg(ExternalID, NDataDecl, "?"));
    var ENTITY_DECL_START = "<!ENTITY";
    var GEDecl = reg(ENTITY_DECL_START, S, Name, S, EntityDef, S_OPT, ">");
    var PEDef = regg(EntityValue, "|", ExternalID);
    var PEDecl = reg(ENTITY_DECL_START, S, "%", S, Name, S, PEDef, S_OPT, ">");
    var EntityDecl = regg(GEDecl, "|", PEDecl);
    var PublicID = reg(PUBLIC, S, PubidLiteral);
    var NotationDecl = reg("<!NOTATION", S, Name, S, regg(ExternalID, "|", PublicID), S_OPT, ">");
    var Eq = reg(S_OPT, "=", S_OPT);
    var VersionNum = /1[.]\d+/;
    var VersionInfo = reg(S, "version", Eq, regg("'", VersionNum, "'", "|", '"', VersionNum, '"'));
    var EncName = /[A-Za-z][-A-Za-z0-9._]*/;
    var EncodingDecl = regg(S, "encoding", Eq, regg('"', EncName, '"', "|", "'", EncName, "'"));
    var SDDecl = regg(S, "standalone", Eq, regg("'", regg("yes", "|", "no"), "'", "|", '"', regg("yes", "|", "no"), '"'));
    var XMLDecl = reg(/^<\?xml/, VersionInfo, EncodingDecl, "?", SDDecl, "?", S_OPT, /\?>/);
    var DOCTYPE_DECL_START = "<!DOCTYPE";
    var CDATA_START = "<![CDATA[";
    var CDATA_END = "]]>";
    var CDStart = /<!\[CDATA\[/;
    var CDEnd = /\]\]>/;
    var CData = reg(Char, "*?", CDEnd);
    var CDSect = reg(CDStart, CData);
    exports.chars = chars;
    exports.chars_without = chars_without;
    exports.detectUnicodeSupport = detectUnicodeSupport;
    exports.reg = reg;
    exports.regg = regg;
    exports.ABOUT_LEGACY_COMPAT = ABOUT_LEGACY_COMPAT;
    exports.ABOUT_LEGACY_COMPAT_SystemLiteral = ABOUT_LEGACY_COMPAT_SystemLiteral;
    exports.AttlistDecl = AttlistDecl;
    exports.CDATA_START = CDATA_START;
    exports.CDATA_END = CDATA_END;
    exports.CDSect = CDSect;
    exports.Char = Char;
    exports.Comment = Comment;
    exports.COMMENT_START = COMMENT_START;
    exports.COMMENT_END = COMMENT_END;
    exports.DOCTYPE_DECL_START = DOCTYPE_DECL_START;
    exports.elementdecl = elementdecl;
    exports.EntityDecl = EntityDecl;
    exports.EntityValue = EntityValue;
    exports.ExternalID = ExternalID;
    exports.ExternalID_match = ExternalID_match;
    exports.Name = Name;
    exports.Name_exact = Name_exact;
    exports.NCName_exact = NCName_exact;
    exports.NotationDecl = NotationDecl;
    exports.Reference = Reference;
    exports.PEReference = PEReference;
    exports.PI = PI;
    exports.PUBLIC = PUBLIC;
    exports.PubidLiteral = PubidLiteral;
    exports.PubidLiteral_match = PubidLiteral_match;
    exports.QName = QName;
    exports.QName_exact = QName_exact;
    exports.QName_group = QName_group;
    exports.S = S;
    exports.SChar_s = SChar_s;
    exports.S_OPT = S_OPT;
    exports.SYSTEM = SYSTEM;
    exports.SystemLiteral = SystemLiteral;
    exports.SystemLiteral_match = SystemLiteral_match;
    exports.InvalidChar = InvalidChar;
    exports.UNICODE_REPLACEMENT_CHARACTER = UNICODE_REPLACEMENT_CHARACTER;
    exports.UNICODE_SUPPORT = UNICODE_SUPPORT;
    exports.XMLDecl = XMLDecl;
  }
});

// node_modules/@xmldom/xmldom/lib/dom.js
var require_dom = __commonJS({
  "node_modules/@xmldom/xmldom/lib/dom.js"(exports) {
    "use strict";
    var conventions = require_conventions();
    var find = conventions.find;
    var hasDefaultHTMLNamespace = conventions.hasDefaultHTMLNamespace;
    var hasOwn = conventions.hasOwn;
    var isHTMLMimeType = conventions.isHTMLMimeType;
    var isHTMLRawTextElement = conventions.isHTMLRawTextElement;
    var isHTMLVoidElement = conventions.isHTMLVoidElement;
    var MIME_TYPE = conventions.MIME_TYPE;
    var NAMESPACE = conventions.NAMESPACE;
    var PDC = /* @__PURE__ */ Symbol();
    var errors = require_errors();
    var DOMException = errors.DOMException;
    var DOMExceptionName = errors.DOMExceptionName;
    var g = require_grammar();
    function checkSymbol(symbol) {
      if (symbol !== PDC) {
        throw new TypeError("Illegal constructor");
      }
    }
    function notEmptyString(input) {
      return input !== "";
    }
    function splitOnASCIIWhitespace(input) {
      return input ? input.split(/[\t\n\f\r ]+/).filter(notEmptyString) : [];
    }
    function orderedSetReducer(current, element) {
      if (!hasOwn(current, element)) {
        current[element] = true;
      }
      return current;
    }
    function toOrderedSet(input) {
      if (!input) return [];
      var list = splitOnASCIIWhitespace(input);
      return Object.keys(list.reduce(orderedSetReducer, {}));
    }
    function arrayIncludes(list) {
      return function(element) {
        return list && list.indexOf(element) !== -1;
      };
    }
    function validateQualifiedName(qualifiedName) {
      if (!g.QName_exact.test(qualifiedName)) {
        throw new DOMException(DOMException.INVALID_CHARACTER_ERR, 'invalid character in qualified name "' + qualifiedName + '"');
      }
    }
    function validateAndExtract(namespace, qualifiedName) {
      validateQualifiedName(qualifiedName);
      namespace = namespace || null;
      var prefix = null;
      var localName = qualifiedName;
      if (qualifiedName.indexOf(":") >= 0) {
        var splitResult = qualifiedName.split(":");
        prefix = splitResult[0];
        localName = splitResult[1];
      }
      if (prefix !== null && namespace === null) {
        throw new DOMException(DOMException.NAMESPACE_ERR, "prefix is non-null and namespace is null");
      }
      if (prefix === "xml" && namespace !== conventions.NAMESPACE.XML) {
        throw new DOMException(DOMException.NAMESPACE_ERR, 'prefix is "xml" and namespace is not the XML namespace');
      }
      if ((prefix === "xmlns" || qualifiedName === "xmlns") && namespace !== conventions.NAMESPACE.XMLNS) {
        throw new DOMException(
          DOMException.NAMESPACE_ERR,
          'either qualifiedName or prefix is "xmlns" and namespace is not the XMLNS namespace'
        );
      }
      if (namespace === conventions.NAMESPACE.XMLNS && prefix !== "xmlns" && qualifiedName !== "xmlns") {
        throw new DOMException(
          DOMException.NAMESPACE_ERR,
          'namespace is the XMLNS namespace and neither qualifiedName nor prefix is "xmlns"'
        );
      }
      return [namespace, prefix, localName];
    }
    function copy(src, dest) {
      for (var p in src) {
        if (hasOwn(src, p)) {
          dest[p] = src[p];
        }
      }
    }
    function _extends(Class, Super) {
      var pt = Class.prototype;
      if (!(pt instanceof Super)) {
        let t = function() {
        };
        t.prototype = Super.prototype;
        t = new t();
        copy(pt, t);
        Class.prototype = pt = t;
      }
      if (pt.constructor != Class) {
        if (typeof Class != "function") {
          console.error("unknown Class:" + Class);
        }
        pt.constructor = Class;
      }
    }
    var NodeType = {};
    var ELEMENT_NODE = NodeType.ELEMENT_NODE = 1;
    var ATTRIBUTE_NODE = NodeType.ATTRIBUTE_NODE = 2;
    var TEXT_NODE = NodeType.TEXT_NODE = 3;
    var CDATA_SECTION_NODE = NodeType.CDATA_SECTION_NODE = 4;
    var ENTITY_REFERENCE_NODE = NodeType.ENTITY_REFERENCE_NODE = 5;
    var ENTITY_NODE = NodeType.ENTITY_NODE = 6;
    var PROCESSING_INSTRUCTION_NODE = NodeType.PROCESSING_INSTRUCTION_NODE = 7;
    var COMMENT_NODE = NodeType.COMMENT_NODE = 8;
    var DOCUMENT_NODE = NodeType.DOCUMENT_NODE = 9;
    var DOCUMENT_TYPE_NODE = NodeType.DOCUMENT_TYPE_NODE = 10;
    var DOCUMENT_FRAGMENT_NODE = NodeType.DOCUMENT_FRAGMENT_NODE = 11;
    var NOTATION_NODE = NodeType.NOTATION_NODE = 12;
    var DocumentPosition = conventions.freeze({
      DOCUMENT_POSITION_DISCONNECTED: 1,
      DOCUMENT_POSITION_PRECEDING: 2,
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_CONTAINS: 8,
      DOCUMENT_POSITION_CONTAINED_BY: 16,
      DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32
    });
    function commonAncestor(a, b) {
      if (b.length < a.length) return commonAncestor(b, a);
      var c = null;
      for (var n in a) {
        if (a[n] !== b[n]) return c;
        c = a[n];
      }
      return c;
    }
    function docGUID(doc) {
      if (!doc.guid) doc.guid = Math.random();
      return doc.guid;
    }
    function NodeList() {
    }
    NodeList.prototype = {
      /**
       * The number of nodes in the list. The range of valid child node indices is 0 to length-1
       * inclusive.
       *
       * @type {number}
       */
      length: 0,
      /**
       * Returns the item at `index`. If index is greater than or equal to the number of nodes in
       * the list, this returns null.
       *
       * @param index
       * Unsigned long Index into the collection.
       * @returns {Node | null}
       * The node at position `index` in the NodeList,
       * or null if that is not a valid index.
       */
      item: function(index) {
        return index >= 0 && index < this.length ? this[index] : null;
      },
      /**
       * Returns a string representation of the NodeList.
       *
       * Accepts the same `options` object as `XMLSerializer.prototype.serializeToString`
       * (`requireWellFormed`, `splitCDATASections`, `nodeFilter`). Passing a function is treated as
       * a legacy `nodeFilter` for backward compatibility.
       *
       * @param {Object | function} [options]
       * @param {boolean} [options.requireWellFormed=false]
       * @param {boolean} [options.splitCDATASections=true]
       * @param {function} [options.nodeFilter]
       * @returns {string}
       */
      toString: function(options) {
        var opts;
        if (typeof options === "function") {
          opts = { requireWellFormed: false, splitCDATASections: true, nodeFilter: options };
        } else if (!!options) {
          opts = {
            requireWellFormed: !!options.requireWellFormed,
            splitCDATASections: options.splitCDATASections !== false,
            nodeFilter: options.nodeFilter || null
          };
        } else {
          opts = { requireWellFormed: false, splitCDATASections: true, nodeFilter: null };
        }
        for (var buf = [], i = 0; i < this.length; i++) {
          serializeToString(this[i], buf, null, opts);
        }
        return buf.join("");
      },
      /**
       * Filters the NodeList based on a predicate.
       *
       * @param {function(Node): boolean} predicate
       * - A predicate function to filter the NodeList.
       * @returns {Node[]}
       * An array of nodes that satisfy the predicate.
       * @private
       */
      filter: function(predicate) {
        return Array.prototype.filter.call(this, predicate);
      },
      /**
       * Returns the first index at which a given node can be found in the NodeList, or -1 if it is
       * not present.
       *
       * @param {Node} item
       * - The Node item to locate in the NodeList.
       * @returns {number}
       * The first index of the node in the NodeList; -1 if not found.
       * @private
       */
      indexOf: function(item) {
        return Array.prototype.indexOf.call(this, item);
      }
    };
    NodeList.prototype[Symbol.iterator] = function() {
      var me = this;
      var index = 0;
      return {
        next: function() {
          if (index < me.length) {
            return {
              value: me[index++],
              done: false
            };
          } else {
            return {
              done: true
            };
          }
        },
        return: function() {
          return {
            done: true
          };
        }
      };
    };
    function LiveNodeList(node, refresh) {
      this._node = node;
      this._refresh = refresh;
      _updateLiveList(this);
    }
    function _updateLiveList(list) {
      var inc = list._node._inc || list._node.ownerDocument._inc;
      if (list._inc !== inc) {
        var ls = list._refresh(list._node);
        __set__(list, "length", ls.length);
        if (!list.$$length || ls.length < list.$$length) {
          for (var i = ls.length; i in list; i++) {
            if (hasOwn(list, i)) {
              delete list[i];
            }
          }
        }
        copy(ls, list);
        list._inc = inc;
      }
    }
    LiveNodeList.prototype.item = function(i) {
      _updateLiveList(this);
      return this[i] || null;
    };
    _extends(LiveNodeList, NodeList);
    function NamedNodeMap() {
      this._nsIndex = /* @__PURE__ */ Object.create(null);
      this._noNsIndex = /* @__PURE__ */ Object.create(null);
    }
    function _findNodeIndex(list, node) {
      var i = 0;
      while (i < list.length) {
        if (list[i] === node) {
          return i;
        }
        i++;
      }
    }
    function _nnmBucket(map, namespaceURI, create) {
      if (!namespaceURI) {
        return map._noNsIndex;
      }
      var bucket = map._nsIndex[namespaceURI];
      if (!bucket && create) {
        bucket = map._nsIndex[namespaceURI] = /* @__PURE__ */ Object.create(null);
      }
      return bucket;
    }
    function _nnmIndexFind(map, namespaceURI, localName) {
      var bucket = _nnmBucket(map, namespaceURI, false);
      var found = bucket && bucket[localName];
      return found ? found : null;
    }
    function _nnmIndexAdd(map, attr) {
      _nnmBucket(map, attr.namespaceURI, true)[attr.localName] = attr;
    }
    function _nnmIndexRemove(map, attr) {
      var bucket = _nnmBucket(map, attr.namespaceURI, false);
      if (bucket) {
        delete bucket[attr.localName];
      }
    }
    function _addNamedNode(el, list, newAttr, oldAttr) {
      if (oldAttr) {
        list[_findNodeIndex(list, oldAttr)] = newAttr;
      } else {
        list[list.length] = newAttr;
        list.length++;
      }
      _nnmIndexAdd(list, newAttr);
      if (el) {
        newAttr.ownerElement = el;
        var doc = el.ownerDocument;
        if (doc) {
          oldAttr && _onRemoveAttribute(doc, el, oldAttr);
          _onAddAttribute(doc, el, newAttr);
        }
      }
    }
    function _removeNamedNode(el, list, attr) {
      var i = _findNodeIndex(list, attr);
      if (i >= 0) {
        var lastIndex = list.length - 1;
        while (i <= lastIndex) {
          list[i] = list[++i];
        }
        list.length = lastIndex;
        _nnmIndexRemove(list, attr);
        if (el) {
          var doc = el.ownerDocument;
          if (doc) {
            _onRemoveAttribute(doc, el, attr);
          }
          attr.ownerElement = null;
        }
      }
    }
    NamedNodeMap.prototype = {
      length: 0,
      item: NodeList.prototype.item,
      /**
       * Get an attribute by name. Note: Name is in lower case in case of HTML namespace and
       * document.
       *
       * @param {string} localName
       * The local name of the attribute.
       * @returns {Attr | null}
       * The attribute with the given local name, or null if no such attribute exists.
       * @see https://dom.spec.whatwg.org/#concept-element-attributes-get-by-name
       */
      getNamedItem: function(localName) {
        if (this._ownerElement && this._ownerElement._isInHTMLDocumentAndNamespace()) {
          localName = localName.toLowerCase();
        }
        var i = 0;
        while (i < this.length) {
          var attr = this[i];
          if (attr.nodeName === localName) {
            return attr;
          }
          i++;
        }
        return null;
      },
      /**
       * Set an attribute.
       *
       * @param {Attr} attr
       * The attribute to set.
       * @returns {Attr | null}
       * The old attribute with the same local name and namespace URI as the new one, or null if no
       * such attribute exists.
       * @throws {DOMException}
       * With code:
       * - {@link INUSE_ATTRIBUTE_ERR} - If the attribute is already an attribute of another
       * element.
       * @see https://dom.spec.whatwg.org/#concept-element-attributes-set
       */
      setNamedItem: function(attr) {
        var el = attr.ownerElement;
        if (el && el !== this._ownerElement) {
          throw new DOMException(DOMException.INUSE_ATTRIBUTE_ERR);
        }
        var oldAttr = _nnmIndexFind(this, attr.namespaceURI, attr.localName);
        if (oldAttr === attr) {
          return attr;
        }
        _addNamedNode(this._ownerElement, this, attr, oldAttr);
        return oldAttr;
      },
      /**
       * Set an attribute, replacing an existing attribute with the same local name and namespace
       * URI if one exists.
       *
       * @param {Attr} attr
       * The attribute to set.
       * @returns {Attr | null}
       * The old attribute with the same local name and namespace URI as the new one, or null if no
       * such attribute exists.
       * @throws {DOMException}
       * Throws a DOMException with the name "InUseAttributeError" if the attribute is already an
       * attribute of another element.
       * @see https://dom.spec.whatwg.org/#concept-element-attributes-set
       */
      setNamedItemNS: function(attr) {
        return this.setNamedItem(attr);
      },
      /**
       * Removes an attribute specified by the local name.
       *
       * @param {string} localName
       * The local name of the attribute to be removed.
       * @returns {Attr}
       * The attribute node that was removed.
       * @throws {DOMException}
       * With code:
       * - {@link DOMException.NOT_FOUND_ERR} if no attribute with the given name is found.
       * @see https://dom.spec.whatwg.org/#dom-namednodemap-removenameditem
       * @see https://dom.spec.whatwg.org/#concept-element-attributes-remove-by-name
       */
      removeNamedItem: function(localName) {
        var attr = this.getNamedItem(localName);
        if (!attr) {
          throw new DOMException(DOMException.NOT_FOUND_ERR, localName);
        }
        _removeNamedNode(this._ownerElement, this, attr);
        return attr;
      },
      /**
       * Removes an attribute specified by the namespace and local name.
       *
       * @param {string | null} namespaceURI
       * The namespace URI of the attribute to be removed.
       * @param {string} localName
       * The local name of the attribute to be removed.
       * @returns {Attr}
       * The attribute node that was removed.
       * @throws {DOMException}
       * With code:
       * - {@link DOMException.NOT_FOUND_ERR} if no attribute with the given namespace URI and local
       * name is found.
       * @see https://dom.spec.whatwg.org/#dom-namednodemap-removenameditemns
       * @see https://dom.spec.whatwg.org/#concept-element-attributes-remove-by-namespace
       */
      removeNamedItemNS: function(namespaceURI, localName) {
        var attr = this.getNamedItemNS(namespaceURI, localName);
        if (!attr) {
          throw new DOMException(DOMException.NOT_FOUND_ERR, namespaceURI ? namespaceURI + " : " + localName : localName);
        }
        _removeNamedNode(this._ownerElement, this, attr);
        return attr;
      },
      /**
       * Get an attribute by namespace and local name.
       *
       * @param {string | null} namespaceURI
       * The namespace URI of the attribute.
       * @param {string} localName
       * The local name of the attribute.
       * @returns {Attr | null}
       * The attribute with the given namespace URI and local name, or null if no such attribute
       * exists.
       * @see https://dom.spec.whatwg.org/#concept-element-attributes-get-by-namespace
       */
      getNamedItemNS: function(namespaceURI, localName) {
        if (!namespaceURI) {
          namespaceURI = null;
        }
        var i = 0;
        while (i < this.length) {
          var node = this[i];
          if (node.localName === localName && node.namespaceURI === namespaceURI) {
            return node;
          }
          i++;
        }
        return null;
      }
    };
    NamedNodeMap.prototype[Symbol.iterator] = function() {
      var me = this;
      var index = 0;
      return {
        next: function() {
          if (index < me.length) {
            return {
              value: me[index++],
              done: false
            };
          } else {
            return {
              done: true
            };
          }
        },
        return: function() {
          return {
            done: true
          };
        }
      };
    };
    function DOMImplementation() {
    }
    DOMImplementation.prototype = {
      /**
       * Test if the DOM implementation implements a specific feature and version, as specified in
       * {@link https://www.w3.org/TR/DOM-Level-3-Core/core.html#DOMFeatures DOM Features}.
       *
       * The DOMImplementation.hasFeature() method returns a Boolean flag indicating if a given
       * feature is supported. The different implementations fairly diverged in what kind of
       * features were reported. The latest version of the spec settled to force this method to
       * always return true, where the functionality was accurate and in use.
       *
       * @deprecated
       * It is deprecated and modern browsers return true in all cases.
       * @function DOMImplementation#hasFeature
       * @param {string} feature
       * The name of the feature to test.
       * @param {string} [version]
       * This is the version number of the feature to test.
       * @returns {boolean}
       * Always returns true.
       * @see https://developer.mozilla.org/en-US/docs/Web/API/DOMImplementation/hasFeature MDN
       * @see https://www.w3.org/TR/REC-DOM-Level-1/level-one-core.html#ID-5CED94D7 DOM Level 1 Core
       * @see https://dom.spec.whatwg.org/#dom-domimplementation-hasfeature DOM Living Standard
       * @see https://www.w3.org/TR/DOM-Level-3-Core/core.html#ID-5CED94D7 DOM Level 3 Core
       */
      hasFeature: function(feature, version) {
        return true;
      },
      /**
       * Creates a DOM Document object of the specified type with its document element. Note that
       * based on the {@link DocumentType}
       * given to create the document, the implementation may instantiate specialized
       * {@link Document} objects that support additional features than the "Core", such as "HTML"
       * {@link https://www.w3.org/TR/DOM-Level-3-Core/references.html#DOM2HTML DOM Level 2 HTML}.
       * On the other hand, setting the {@link DocumentType} after the document was created makes
       * this very unlikely to happen. Alternatively, specialized {@link Document} creation methods,
       * such as createHTMLDocument
       * {@link https://www.w3.org/TR/DOM-Level-3-Core/references.html#DOM2HTML DOM Level 2 HTML},
       * can be used to obtain specific types of {@link Document} objects.
       *
       * __It behaves slightly different from the description in the living standard__:
       * - There is no interface/class `XMLDocument`, it returns a `Document`
       * instance (with it's `type` set to `'xml'`).
       * - `encoding`, `mode`, `origin`, `url` fields are currently not declared.
       *
       * @function DOMImplementation.createDocument
       * @param {string | null} namespaceURI
       * The
       * {@link https://www.w3.org/TR/DOM-Level-3-Core/glossary.html#dt-namespaceURI namespace URI}
       * of the document element to create or null.
       * @param {string | null} qualifiedName
       * The
       * {@link https://www.w3.org/TR/DOM-Level-3-Core/glossary.html#dt-qualifiedname qualified name}
       * of the document element to be created or null.
       * @param {DocumentType | null} [doctype=null]
       * The type of document to be created or null. When doctype is not null, its
       * {@link Node#ownerDocument} attribute is set to the document being created. Default is
       * `null`
       * @returns {Document}
       * A new {@link Document} object with its document element. If the NamespaceURI,
       * qualifiedName, and doctype are null, the returned {@link Document} is empty with no
       * document element.
       * @throws {DOMException}
       * With code:
       *
       * - `INVALID_CHARACTER_ERR`: Raised if the specified qualified name is not an XML name
       * according to {@link https://www.w3.org/TR/DOM-Level-3-Core/references.html#XML XML 1.0}.
       * - `NAMESPACE_ERR`: Raised if the qualifiedName is malformed, if the qualifiedName has a
       * prefix and the namespaceURI is null, or if the qualifiedName is null and the namespaceURI
       * is different from null, or if the qualifiedName has a prefix that is "xml" and the
       * namespaceURI is different from "{@link http://www.w3.org/XML/1998/namespace}"
       * {@link https://www.w3.org/TR/DOM-Level-3-Core/references.html#Namespaces XML Namespaces},
       * or if the DOM implementation does not support the "XML" feature but a non-null namespace
       * URI was provided, since namespaces were defined by XML.
       * - `WRONG_DOCUMENT_ERR`: Raised if doctype has already been used with a different document
       * or was created from a different implementation.
       * - `NOT_SUPPORTED_ERR`: May be raised if the implementation does not support the feature
       * "XML" and the language exposed through the Document does not support XML Namespaces (such
       * as {@link https://www.w3.org/TR/DOM-Level-3-Core/references.html#HTML40 HTML 4.01}).
       * @since DOM Level 2.
       * @see {@link #createHTMLDocument}
       * @see https://developer.mozilla.org/en-US/docs/Web/API/DOMImplementation/createDocument MDN
       * @see https://dom.spec.whatwg.org/#dom-domimplementation-createdocument DOM Living Standard
       * @see https://www.w3.org/TR/DOM-Level-3-Core/core.html#Level-2-Core-DOM-createDocument DOM
       *      Level 3 Core
       * @see https://www.w3.org/TR/DOM-Level-2-Core/core.html#Level-2-Core-DOM-createDocument DOM
       *      Level 2 Core (initial)
       */
      createDocument: function(namespaceURI, qualifiedName, doctype) {
        var contentType = MIME_TYPE.XML_APPLICATION;
        if (namespaceURI === NAMESPACE.HTML) {
          contentType = MIME_TYPE.XML_XHTML_APPLICATION;
        } else if (namespaceURI === NAMESPACE.SVG) {
          contentType = MIME_TYPE.XML_SVG_IMAGE;
        }
        var doc = new Document(PDC, { contentType });
        doc.implementation = this;
        doc.childNodes = new NodeList();
        doc.doctype = doctype || null;
        if (doctype) {
          doc.appendChild(doctype);
        }
        if (qualifiedName) {
          var root = doc.createElementNS(namespaceURI, qualifiedName);
          doc.appendChild(root);
        }
        return doc;
      },
      /**
       * Creates an empty DocumentType node. Entity declarations and notations are not made
       * available. Entity reference expansions and default attribute additions do not occur.
       *
       * **This behavior is slightly different from the one in the specs**:
       * - `encoding`, `mode`, `origin`, `url` fields are currently not declared.
       * - `publicId` and `systemId` contain the raw data including any possible quotes,
       *   so they can always be serialized back to the original value
       * - `internalSubset` contains the raw string between `[` and `]` if present,
       *   but is not parsed or validated in any form.
       *
       * @function DOMImplementation#createDocumentType
       * @param {string} qualifiedName
       * The {@link https://www.w3.org/TR/DOM-Level-3-Core/glossary.html#dt-qualifiedname qualified
       * name} of the document type to be created.
       * @param {string} [publicId]
       * The external subset public identifier. Stored verbatim including surrounding quotes.
       * When serialized with `requireWellFormed: true`, the serializer throws `InvalidStateError`
       * if the value is non-empty and does not match the XML `PubidLiteral` production
       * (W3C DOM Parsing §3.2.1.3; XML 1.0 production [12]). Creation-time validation is not
       * enforced — deferred to a future breaking release.
       * @param {string} [systemId]
       * The external subset system identifier. Stored verbatim including surrounding quotes.
       * When serialized with `requireWellFormed: true`, the serializer throws `InvalidStateError`
       * if the value is non-empty and does not match the XML `SystemLiteral` production
       * (W3C DOM Parsing §3.2.1.3; XML 1.0 production [11]). Creation-time validation is not
       * enforced — deferred to a future breaking release.
       * @param {string} [internalSubset]
       * The internal subset or an empty string if it is not present. Stored verbatim.
       * When serialized with `requireWellFormed: true`, the serializer throws `InvalidStateError`
       * if the value contains `"]>"`. Creation-time validation is not enforced.
       * @returns {DocumentType}
       * A new {@link DocumentType} node with {@link Node#ownerDocument} set to null.
       * @throws {DOMException}
       * With code:
       *
       * - `INVALID_CHARACTER_ERR`: Raised if the specified qualified name is not an XML name
       * according to {@link https://www.w3.org/TR/DOM-Level-3-Core/references.html#XML XML 1.0}.
       * - `NAMESPACE_ERR`: Raised if the qualifiedName is malformed.
       * - `NOT_SUPPORTED_ERR`: May be raised if the implementation does not support the feature
       * "XML" and the language exposed through the Document does not support XML Namespaces (such
       * as {@link https://www.w3.org/TR/DOM-Level-3-Core/references.html#HTML40 HTML 4.01}).
       * @since DOM Level 2.
       * @see https://developer.mozilla.org/en-US/docs/Web/API/DOMImplementation/createDocumentType
       *      MDN
       * @see https://dom.spec.whatwg.org/#dom-domimplementation-createdocumenttype DOM Living
       *      Standard
       * @see https://www.w3.org/TR/DOM-Level-3-Core/core.html#Level-3-Core-DOM-createDocType DOM
       *      Level 3 Core
       * @see https://www.w3.org/TR/DOM-Level-2-Core/core.html#Level-2-Core-DOM-createDocType DOM
       *      Level 2 Core
       * @see https://github.com/xmldom/xmldom/blob/master/CHANGELOG.md#050
       * @see https://www.w3.org/TR/DOM-Level-2-Core/#core-ID-Core-DocType-internalSubset
       * @prettierignore
       */
      createDocumentType: function(qualifiedName, publicId, systemId, internalSubset) {
        validateQualifiedName(qualifiedName);
        var node = new DocumentType(PDC);
        node.name = qualifiedName;
        node.nodeName = qualifiedName;
        node.publicId = publicId || "";
        node.systemId = systemId || "";
        node.internalSubset = internalSubset || "";
        node.childNodes = new NodeList();
        return node;
      },
      /**
       * Returns an HTML document, that might already have a basic DOM structure.
       *
       * __It behaves slightly different from the description in the living standard__:
       * - If the first argument is `false` no initial nodes are added (steps 3-7 in the specs are
       * omitted)
       * - `encoding`, `mode`, `origin`, `url` fields are currently not declared.
       *
       * @param {string | false} [title]
       * A string containing the title to give the new HTML document.
       * @returns {Document}
       * The HTML document.
       * @since WHATWG Living Standard.
       * @see {@link #createDocument}
       * @see https://dom.spec.whatwg.org/#dom-domimplementation-createhtmldocument
       * @see https://dom.spec.whatwg.org/#html-document
       */
      createHTMLDocument: function(title) {
        var doc = new Document(PDC, { contentType: MIME_TYPE.HTML });
        doc.implementation = this;
        doc.childNodes = new NodeList();
        if (title !== false) {
          doc.doctype = this.createDocumentType("html");
          doc.doctype.ownerDocument = doc;
          doc.appendChild(doc.doctype);
          var htmlNode = doc.createElement("html");
          doc.appendChild(htmlNode);
          var headNode = doc.createElement("head");
          htmlNode.appendChild(headNode);
          if (typeof title === "string") {
            var titleNode = doc.createElement("title");
            titleNode.appendChild(doc.createTextNode(title));
            headNode.appendChild(titleNode);
          }
          htmlNode.appendChild(doc.createElement("body"));
        }
        return doc;
      }
    };
    function Node(symbol) {
      checkSymbol(symbol);
    }
    Node.prototype = {
      /**
       * The first child of this node.
       *
       * @type {Node | null}
       */
      firstChild: null,
      /**
       * The last child of this node.
       *
       * @type {Node | null}
       */
      lastChild: null,
      /**
       * The previous sibling of this node.
       *
       * @type {Node | null}
       */
      previousSibling: null,
      /**
       * The next sibling of this node.
       *
       * @type {Node | null}
       */
      nextSibling: null,
      /**
       * The parent node of this node.
       *
       * @type {Node | null}
       */
      parentNode: null,
      /**
       * The parent element of this node.
       *
       * @type {Element | null}
       */
      get parentElement() {
        return this.parentNode && this.parentNode.nodeType === this.ELEMENT_NODE ? this.parentNode : null;
      },
      /**
       * The child nodes of this node.
       *
       * @type {NodeList}
       */
      childNodes: null,
      /**
       * The document object associated with this node.
       *
       * @type {Document | null}
       */
      ownerDocument: null,
      /**
       * The value of this node.
       *
       * @type {string | null}
       */
      nodeValue: null,
      /**
       * The namespace URI of this node.
       *
       * @type {string | null}
       */
      namespaceURI: null,
      /**
       * The prefix of the namespace for this node.
       *
       * @type {string | null}
       */
      prefix: null,
      /**
       * The local part of the qualified name of this node.
       *
       * @type {string | null}
       */
      localName: null,
      /**
       * The baseURI is currently always `about:blank`,
       * since that's what happens when you create a document from scratch.
       *
       * @type {'about:blank'}
       */
      baseURI: "about:blank",
      /**
       * Is true if this node is part of a document.
       *
       * @type {boolean}
       */
      get isConnected() {
        var rootNode = this.getRootNode();
        return rootNode && rootNode.nodeType === rootNode.DOCUMENT_NODE;
      },
      /**
       * Checks whether `other` is an inclusive descendant of this node.
       *
       * @param {Node | null | undefined} other
       * The node to check.
       * @returns {boolean}
       * True if `other` is an inclusive descendant of this node; false otherwise.
       * @see https://dom.spec.whatwg.org/#dom-node-contains
       */
      contains: function(other) {
        if (!other) return false;
        var parent = other;
        do {
          if (this === parent) return true;
          parent = parent.parentNode;
        } while (parent);
        return false;
      },
      /**
       * @typedef GetRootNodeOptions
       * @property {boolean} [composed=false]
       */
      /**
       * Searches for the root node of this node.
       *
       * **This behavior is slightly different from the in the specs**:
       * - ignores `options.composed`, since `ShadowRoot`s are unsupported, always returns root.
       *
       * @param {GetRootNodeOptions} [options]
       * @returns {Node}
       * Root node.
       * @see https://dom.spec.whatwg.org/#dom-node-getrootnode
       * @see https://dom.spec.whatwg.org/#concept-shadow-including-root
       */
      getRootNode: function(options) {
        var parent = this;
        do {
          if (!parent.parentNode) {
            return parent;
          }
          parent = parent.parentNode;
        } while (parent);
      },
      /**
       * Checks whether the given node is equal to this node.
       *
       * Two nodes are equal when they have the same type, defining characteristics (for the type),
       * and the same childNodes. The comparison is iterative to avoid stack overflows on
       * deeply-nested trees. Attribute nodes of each Element pair are also pushed onto the stack
       * and compared the same way.
       *
       * @param {Node} [otherNode]
       * @returns {boolean}
       * @see https://dom.spec.whatwg.org/#concept-node-equals
       * @see ../docs/walk-dom.md.
       */
      isEqualNode: function(otherNode) {
        if (!otherNode) return false;
        var stack = [{ node: this, other: otherNode }];
        while (stack.length > 0) {
          var pair = stack.pop();
          var node = pair.node;
          var other = pair.other;
          if (node.nodeType !== other.nodeType) return false;
          switch (node.nodeType) {
            case node.DOCUMENT_TYPE_NODE:
              if (node.name !== other.name) return false;
              if (node.publicId !== other.publicId) return false;
              if (node.systemId !== other.systemId) return false;
              break;
            case node.ELEMENT_NODE:
              if (node.namespaceURI !== other.namespaceURI) return false;
              if (node.prefix !== other.prefix) return false;
              if (node.localName !== other.localName) return false;
              if (node.attributes.length !== other.attributes.length) return false;
              for (var i = 0; i < node.attributes.length; i++) {
                var attr = node.attributes.item(i);
                var otherAttr = other.getAttributeNodeNS(attr.namespaceURI, attr.localName);
                if (!otherAttr) return false;
                stack.push({ node: attr, other: otherAttr });
              }
              break;
            case node.ATTRIBUTE_NODE:
              if (node.namespaceURI !== other.namespaceURI) return false;
              if (node.localName !== other.localName) return false;
              if (node.value !== other.value) return false;
              break;
            case node.PROCESSING_INSTRUCTION_NODE:
              if (node.target !== other.target || node.data !== other.data) return false;
              break;
            case node.TEXT_NODE:
            case node.CDATA_SECTION_NODE:
            case node.COMMENT_NODE:
              if (node.data !== other.data) return false;
              break;
          }
          if (node.childNodes.length !== other.childNodes.length) return false;
          for (var i = node.childNodes.length - 1; i >= 0; i--) {
            stack.push({ node: node.childNodes[i], other: other.childNodes[i] });
          }
        }
        return true;
      },
      /**
       * Checks whether or not the given node is this node.
       *
       * @param {Node} [otherNode]
       */
      isSameNode: function(otherNode) {
        return this === otherNode;
      },
      /**
       * Inserts a node before a reference node as a child of this node.
       *
       * @param {Node} newChild
       * The new child node to be inserted.
       * @param {Node | null} refChild
       * The reference node before which newChild will be inserted.
       * @returns {Node}
       * The new child node successfully inserted.
       * @throws {DOMException}
       * Throws a DOMException if inserting the node would result in a DOM tree that is not
       * well-formed, or if `child` is provided but is not a child of `parent`.
       * See {@link _insertBefore} for more details.
       * @since Modified in DOM L2
       */
      insertBefore: function(newChild, refChild) {
        return _insertBefore(this, newChild, refChild);
      },
      /**
       * Replaces an old child node with a new child node within this node.
       *
       * @param {Node} newChild
       * The new node that is to replace the old node.
       * If it already exists in the DOM, it is removed from its original position.
       * @param {Node} oldChild
       * The existing child node to be replaced.
       * @returns {Node}
       * Returns the replaced child node.
       * @throws {DOMException}
       * Throws a DOMException if replacing the node would result in a DOM tree that is not
       * well-formed, or if `oldChild` is not a child of `this`.
       * This can also occur if the pre-replacement validity assertion fails.
       * See {@link _insertBefore}, {@link Node.removeChild}, and
       * {@link assertPreReplacementValidityInDocument} for more details.
       * @see https://dom.spec.whatwg.org/#concept-node-replace
       */
      replaceChild: function(newChild, oldChild) {
        _insertBefore(this, newChild, oldChild, assertPreReplacementValidityInDocument);
        if (oldChild) {
          this.removeChild(oldChild);
        }
      },
      /**
       * Removes an existing child node from this node.
       *
       * @param {Node} oldChild
       * The child node to be removed.
       * @returns {Node}
       * Returns the removed child node.
       * @throws {DOMException}
       * Throws a DOMException if `oldChild` is not a child of `this`.
       * See {@link _removeChild} for more details.
       */
      removeChild: function(oldChild) {
        return _removeChild(this, oldChild);
      },
      /**
       * Appends a child node to this node.
       *
       * @param {Node} newChild
       * The child node to be appended to this node.
       * If it already exists in the DOM, it is removed from its original position.
       * @returns {Node}
       * Returns the appended child node.
       * @throws {DOMException}
       * Throws a DOMException if appending the node would result in a DOM tree that is not
       * well-formed, or if `newChild` is not a valid Node.
       * See {@link insertBefore} for more details.
       */
      appendChild: function(newChild) {
        return this.insertBefore(newChild, null);
      },
      /**
       * Determines whether this node has any child nodes.
       *
       * @returns {boolean}
       * Returns true if this node has any child nodes, and false otherwise.
       */
      hasChildNodes: function() {
        return this.firstChild != null;
      },
      /**
       * Creates a copy of the calling node.
       *
       * @param {boolean} deep
       * If true, the contents of the node are recursively copied.
       * If false, only the node itself (and its attributes, if it is an element) are copied.
       * @returns {Node}
       * Returns the newly created copy of the node.
       * @throws {DOMException}
       * May throw a DOMException if operations within {@link Element#setAttributeNode} or
       * {@link Node#appendChild} (which are potentially invoked in this method) do not meet their
       * specific constraints.
       * @see {@link cloneNode}
       */
      cloneNode: function(deep) {
        return cloneNode(this.ownerDocument || this, this, deep);
      },
      /**
       * Puts the specified node and all of its subtree into a "normalized" form. In a normalized
       * subtree, no text nodes in the subtree are empty and there are no adjacent text nodes.
       *
       * Specifically, this method merges any adjacent text nodes (i.e., nodes for which `nodeType`
       * is `TEXT_NODE`) into a single node with the combined data. It also removes any empty text
       * nodes.
       *
       * This method iterativly traverses all child nodes to normalize all descendent nodes within
       * the subtree.
       *
       * @throws {DOMException}
       * May throw a DOMException if operations within removeChild or appendData (which are
       * potentially invoked in this method) do not meet their specific constraints.
       * @since Modified in DOM Level 2
       * @see {@link Node.removeChild}
       * @see {@link CharacterData.appendData}
       * @see ../docs/walk-dom.md.
       */
      normalize: function() {
        walkDOM(this, null, {
          enter: function(node) {
            var child2 = node.firstChild;
            while (child2) {
              var next = child2.nextSibling;
              if (next !== null && next.nodeType === TEXT_NODE && child2.nodeType === TEXT_NODE) {
                var tail = [];
                var sibling = next;
                while (sibling !== null && sibling.nodeType === TEXT_NODE) {
                  tail.push(sibling.data);
                  sibling = sibling.nextSibling;
                }
                var removed = child2.nextSibling;
                while (removed !== sibling) {
                  var following = removed.nextSibling;
                  removed.parentNode = null;
                  removed.previousSibling = null;
                  removed.nextSibling = null;
                  removed = following;
                }
                child2.nextSibling = sibling;
                if (sibling !== null) {
                  sibling.previousSibling = child2;
                } else {
                  node.lastChild = child2;
                }
                child2.appendData(tail.join(""));
                _onUpdateChild(node.ownerDocument, node);
                child2 = sibling;
              } else {
                child2 = next;
              }
            }
            return true;
          }
        });
      },
      /**
       * Checks whether the DOM implementation implements a specific feature and its version.
       *
       * @deprecated
       * Since `DOMImplementation.hasFeature` is deprecated and always returns true.
       * @param {string} feature
       * The package name of the feature to test. This is the same name that can be passed to the
       * method `hasFeature` on `DOMImplementation`.
       * @param {string} version
       * This is the version number of the package name to test.
       * @returns {boolean}
       * Returns true in all cases in the current implementation.
       * @since Introduced in DOM Level 2
       * @see {@link DOMImplementation.hasFeature}
       */
      isSupported: function(feature, version) {
        return this.ownerDocument.implementation.hasFeature(feature, version);
      },
      /**
       * Look up the prefix associated to the given namespace URI, starting from this node.
       * **The default namespace declarations are ignored by this method.**
       * See Namespace Prefix Lookup for details on the algorithm used by this method.
       *
       * **This behavior is different from the in the specs**:
       * - no node type specific handling
       * - uses the internal attribute _nsMap for resolving namespaces that is updated when changing attributes
       *
       * @param {string | null} namespaceURI
       * The namespace URI for which to find the associated prefix.
       * @returns {string | null}
       * The associated prefix, if found; otherwise, null.
       * @see https://www.w3.org/TR/DOM-Level-3-Core/core.html#Node3-lookupNamespacePrefix
       * @see https://www.w3.org/TR/DOM-Level-3-Core/namespaces-algorithms.html#lookupNamespacePrefixAlgo
       * @see https://dom.spec.whatwg.org/#dom-node-lookupprefix
       * @see https://github.com/xmldom/xmldom/issues/322
       * @prettierignore
       */
      lookupPrefix: function(namespaceURI) {
        var el = this;
        while (el) {
          var map = el._nsMap;
          if (map) {
            for (var n in map) {
              if (hasOwn(map, n) && map[n] === namespaceURI) {
                return n;
              }
            }
          }
          el = el.nodeType == ATTRIBUTE_NODE ? el.ownerDocument : el.parentNode;
        }
        return null;
      },
      /**
       * This function is used to look up the namespace URI associated with the given prefix,
       * starting from this node.
       *
       * **This behavior is different from the in the specs**:
       * - no node type specific handling
       * - uses the internal attribute _nsMap for resolving namespaces that is updated when changing attributes
       *
       * @param {string | null} prefix
       * The prefix for which to find the associated namespace URI.
       * @returns {string | null}
       * The associated namespace URI, if found; otherwise, null.
       * @since DOM Level 3
       * @see https://dom.spec.whatwg.org/#dom-node-lookupnamespaceuri
       * @see https://www.w3.org/TR/DOM-Level-3-Core/core.html#Node3-lookupNamespaceURI
       * @prettierignore
       */
      lookupNamespaceURI: function(prefix) {
        var el = this;
        while (el) {
          var map = el._nsMap;
          if (map) {
            if (hasOwn(map, prefix)) {
              return map[prefix];
            }
          }
          el = el.nodeType == ATTRIBUTE_NODE ? el.ownerDocument : el.parentNode;
        }
        return null;
      },
      /**
       * Determines whether the given namespace URI is the default namespace.
       *
       * The function works by looking up the prefix associated with the given namespace URI. If no
       * prefix is found (i.e., the namespace URI is not registered in the namespace map of this
       * node or any of its ancestors), it returns `true`, implying the namespace URI is considered
       * the default.
       *
       * **This behavior is different from the in the specs**:
       * - no node type specific handling
       * - uses the internal attribute _nsMap for resolving namespaces that is updated when changing attributes
       *
       * @param {string | null} namespaceURI
       * The namespace URI to be checked.
       * @returns {boolean}
       * Returns true if the given namespace URI is the default namespace, false otherwise.
       * @since DOM Level 3
       * @see https://www.w3.org/TR/DOM-Level-3-Core/core.html#Node3-isDefaultNamespace
       * @see https://dom.spec.whatwg.org/#dom-node-isdefaultnamespace
       * @prettierignore
       */
      isDefaultNamespace: function(namespaceURI) {
        var prefix = this.lookupPrefix(namespaceURI);
        return prefix == null;
      },
      /**
       * Compares the reference node with a node with regard to their position in the document and
       * according to the document order.
       *
       * @param {Node} other
       * The node to compare the reference node to.
       * @returns {number}
       * Returns how the node is positioned relatively to the reference node according to the
       * bitmask. 0 if reference node and given node are the same.
       * @since DOM Level 3
       * @see https://www.w3.org/TR/2004/REC-DOM-Level-3-Core-20040407/core.html#Node3-compare
       * @see https://dom.spec.whatwg.org/#dom-node-comparedocumentposition
       */
      compareDocumentPosition: function(other) {
        if (this === other) return 0;
        var node1 = other;
        var node2 = this;
        var attr1 = null;
        var attr2 = null;
        if (node1 instanceof Attr) {
          attr1 = node1;
          node1 = attr1.ownerElement;
        }
        if (node2 instanceof Attr) {
          attr2 = node2;
          node2 = attr2.ownerElement;
          if (attr1 && node1 && node2 === node1) {
            for (var i = 0, attr; attr = node2.attributes[i]; i++) {
              if (attr === attr1)
                return DocumentPosition.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC + DocumentPosition.DOCUMENT_POSITION_PRECEDING;
              if (attr === attr2)
                return DocumentPosition.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC + DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
            }
          }
        }
        if (!node1 || !node2 || node2.ownerDocument !== node1.ownerDocument) {
          return DocumentPosition.DOCUMENT_POSITION_DISCONNECTED + DocumentPosition.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC + (docGUID(node2.ownerDocument) > docGUID(node1.ownerDocument) ? DocumentPosition.DOCUMENT_POSITION_FOLLOWING : DocumentPosition.DOCUMENT_POSITION_PRECEDING);
        }
        if (attr2 && node1 === node2) {
          return DocumentPosition.DOCUMENT_POSITION_CONTAINS + DocumentPosition.DOCUMENT_POSITION_PRECEDING;
        }
        if (attr1 && node1 === node2) {
          return DocumentPosition.DOCUMENT_POSITION_CONTAINED_BY + DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
        }
        var chain1 = [];
        var ancestor1 = node1.parentNode;
        while (ancestor1) {
          if (!attr2 && ancestor1 === node2) {
            return DocumentPosition.DOCUMENT_POSITION_CONTAINED_BY + DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
          }
          chain1.push(ancestor1);
          ancestor1 = ancestor1.parentNode;
        }
        chain1.reverse();
        var chain2 = [];
        var ancestor2 = node2.parentNode;
        while (ancestor2) {
          if (!attr1 && ancestor2 === node1) {
            return DocumentPosition.DOCUMENT_POSITION_CONTAINS + DocumentPosition.DOCUMENT_POSITION_PRECEDING;
          }
          chain2.push(ancestor2);
          ancestor2 = ancestor2.parentNode;
        }
        chain2.reverse();
        var ca = commonAncestor(chain1, chain2);
        for (var n in ca.childNodes) {
          var child2 = ca.childNodes[n];
          if (child2 === node2) return DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
          if (child2 === node1) return DocumentPosition.DOCUMENT_POSITION_PRECEDING;
          if (chain2.indexOf(child2) >= 0) return DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
          if (chain1.indexOf(child2) >= 0) return DocumentPosition.DOCUMENT_POSITION_PRECEDING;
        }
        return 0;
      }
    };
    function _xmlEncoder(c) {
      return c == "<" && "&lt;" || c == ">" && "&gt;" || c == "&" && "&amp;" || c == '"' && "&quot;" || "&#" + c.charCodeAt() + ";";
    }
    copy(NodeType, Node);
    copy(NodeType, Node.prototype);
    copy(DocumentPosition, Node);
    copy(DocumentPosition, Node.prototype);
    function _visitNode(node, callback) {
      walkDOM(node, null, {
        enter: function(n) {
          return callback(n) ? walkDOM.STOP : true;
        }
      });
    }
    function walkDOM(node, context, callbacks) {
      var stack = [{ node, context, phase: walkDOM.ENTER }];
      while (stack.length > 0) {
        var frame = stack.pop();
        if (frame.phase === walkDOM.ENTER) {
          var childContext = callbacks.enter(frame.node, frame.context);
          if (childContext === walkDOM.STOP) {
            return walkDOM.STOP;
          }
          stack.push({ node: frame.node, context: childContext, phase: walkDOM.EXIT });
          if (childContext === null || childContext === void 0) {
            continue;
          }
          var child2 = frame.node.lastChild;
          while (child2) {
            stack.push({ node: child2, context: childContext, phase: walkDOM.ENTER });
            child2 = child2.previousSibling;
          }
        } else {
          if (callbacks.exit) {
            callbacks.exit(frame.node, frame.context);
          }
        }
      }
    }
    walkDOM.STOP = /* @__PURE__ */ Symbol("walkDOM.STOP");
    walkDOM.ENTER = 0;
    walkDOM.EXIT = 1;
    function Document(symbol, options) {
      checkSymbol(symbol);
      var opt = options || {};
      this.ownerDocument = this;
      this.contentType = opt.contentType || MIME_TYPE.XML_APPLICATION;
      this.type = isHTMLMimeType(this.contentType) ? "html" : "xml";
    }
    function _onAddAttribute(doc, el, newAttr) {
      doc && doc._inc++;
      var ns = newAttr.namespaceURI;
      if (ns === NAMESPACE.XMLNS) {
        el._nsMap[newAttr.prefix ? newAttr.localName : ""] = newAttr.value;
      }
    }
    function _onRemoveAttribute(doc, el, newAttr, remove) {
      doc && doc._inc++;
      var ns = newAttr.namespaceURI;
      if (ns === NAMESPACE.XMLNS) {
        delete el._nsMap[newAttr.prefix ? newAttr.localName : ""];
      }
    }
    function _onUpdateChild(doc, parent, newChild) {
      if (doc && doc._inc) {
        doc._inc++;
        var childNodes = parent.childNodes;
        if (newChild && !newChild.nextSibling) {
          childNodes[childNodes.length++] = newChild;
        } else {
          var child2 = parent.firstChild;
          var i = 0;
          while (child2) {
            childNodes[i++] = child2;
            child2 = child2.nextSibling;
          }
          childNodes.length = i;
          delete childNodes[childNodes.length];
        }
      }
    }
    function _removeChild(parentNode, child2) {
      if (parentNode !== child2.parentNode) {
        throw new DOMException(DOMException.NOT_FOUND_ERR, "child's parent is not parent");
      }
      var oldPreviousSibling = child2.previousSibling;
      var oldNextSibling = child2.nextSibling;
      if (oldPreviousSibling) {
        oldPreviousSibling.nextSibling = oldNextSibling;
      } else {
        parentNode.firstChild = oldNextSibling;
      }
      if (oldNextSibling) {
        oldNextSibling.previousSibling = oldPreviousSibling;
      } else {
        parentNode.lastChild = oldPreviousSibling;
      }
      _onUpdateChild(parentNode.ownerDocument, parentNode);
      child2.parentNode = null;
      child2.previousSibling = null;
      child2.nextSibling = null;
      return child2;
    }
    function hasValidParentNodeType(node) {
      return node && (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.ELEMENT_NODE);
    }
    function hasInsertableNodeType(node) {
      return node && (node.nodeType === Node.CDATA_SECTION_NODE || node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.DOCUMENT_TYPE_NODE || node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE || node.nodeType === Node.TEXT_NODE);
    }
    function isDocTypeNode(node) {
      return node && node.nodeType === Node.DOCUMENT_TYPE_NODE;
    }
    function isElementNode(node) {
      return node && node.nodeType === Node.ELEMENT_NODE;
    }
    function isTextNode(node) {
      return node && node.nodeType === Node.TEXT_NODE;
    }
    function isElementInsertionPossible(doc, child2) {
      var parentChildNodes = doc.childNodes || [];
      if (find(parentChildNodes, isElementNode) || isDocTypeNode(child2)) {
        return false;
      }
      var docTypeNode = find(parentChildNodes, isDocTypeNode);
      return !(child2 && docTypeNode && parentChildNodes.indexOf(docTypeNode) > parentChildNodes.indexOf(child2));
    }
    function isElementReplacementPossible(doc, child2) {
      var parentChildNodes = doc.childNodes || [];
      function hasElementChildThatIsNotChild(node) {
        return isElementNode(node) && node !== child2;
      }
      if (find(parentChildNodes, hasElementChildThatIsNotChild)) {
        return false;
      }
      var docTypeNode = find(parentChildNodes, isDocTypeNode);
      return !(child2 && docTypeNode && parentChildNodes.indexOf(docTypeNode) > parentChildNodes.indexOf(child2));
    }
    function assertPreInsertionValidity1to5(parent, node, child2) {
      if (!hasValidParentNodeType(parent)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Unexpected parent node type " + parent.nodeType);
      }
      if (child2 && child2.parentNode !== parent) {
        throw new DOMException(DOMException.NOT_FOUND_ERR, "child not in parent");
      }
      if (
        // 4. If `node` is not a DocumentFragment, DocumentType, Element, or CharacterData node, then throw a "HierarchyRequestError" DOMException.
        !hasInsertableNodeType(node) || // 5. If either `node` is a Text node and `parent` is a document,
        // the sax parser currently adds top level text nodes, this will be fixed in 0.9.0
        // || (node.nodeType === Node.TEXT_NODE && parent.nodeType === Node.DOCUMENT_NODE)
        // or `node` is a doctype and `parent` is not a document, then throw a "HierarchyRequestError" DOMException.
        isDocTypeNode(node) && parent.nodeType !== Node.DOCUMENT_NODE
      ) {
        throw new DOMException(
          DOMException.HIERARCHY_REQUEST_ERR,
          "Unexpected node type " + node.nodeType + " for parent node type " + parent.nodeType
        );
      }
    }
    function assertPreInsertionValidityInDocument(parent, node, child2) {
      var parentChildNodes = parent.childNodes || [];
      var nodeChildNodes = node.childNodes || [];
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        var nodeChildElements = nodeChildNodes.filter(isElementNode);
        if (nodeChildElements.length > 1 || find(nodeChildNodes, isTextNode)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "More than one element or text in fragment");
        }
        if (nodeChildElements.length === 1 && !isElementInsertionPossible(parent, child2)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Element in fragment can not be inserted before doctype");
        }
      }
      if (isElementNode(node)) {
        if (!isElementInsertionPossible(parent, child2)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Only one element can be added and only after doctype");
        }
      }
      if (isDocTypeNode(node)) {
        if (find(parentChildNodes, isDocTypeNode)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Only one doctype is allowed");
        }
        var parentElementChild = find(parentChildNodes, isElementNode);
        if (child2 && parentChildNodes.indexOf(parentElementChild) < parentChildNodes.indexOf(child2)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Doctype can only be inserted before an element");
        }
        if (!child2 && parentElementChild) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Doctype can not be appended since element is present");
        }
      }
    }
    function assertPreReplacementValidityInDocument(parent, node, child2) {
      var parentChildNodes = parent.childNodes || [];
      var nodeChildNodes = node.childNodes || [];
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        var nodeChildElements = nodeChildNodes.filter(isElementNode);
        if (nodeChildElements.length > 1 || find(nodeChildNodes, isTextNode)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "More than one element or text in fragment");
        }
        if (nodeChildElements.length === 1 && !isElementReplacementPossible(parent, child2)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Element in fragment can not be inserted before doctype");
        }
      }
      if (isElementNode(node)) {
        if (!isElementReplacementPossible(parent, child2)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Only one element can be added and only after doctype");
        }
      }
      if (isDocTypeNode(node)) {
        let hasDoctypeChildThatIsNotChild = function(node2) {
          return isDocTypeNode(node2) && node2 !== child2;
        };
        if (find(parentChildNodes, hasDoctypeChildThatIsNotChild)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Only one doctype is allowed");
        }
        var parentElementChild = find(parentChildNodes, isElementNode);
        if (child2 && parentChildNodes.indexOf(parentElementChild) < parentChildNodes.indexOf(child2)) {
          throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Doctype can only be inserted before an element");
        }
      }
    }
    function _insertBefore(parent, node, child2, _inDocumentAssertion) {
      assertPreInsertionValidity1to5(parent, node, child2);
      if (parent.nodeType === Node.DOCUMENT_NODE) {
        (_inDocumentAssertion || assertPreInsertionValidityInDocument)(parent, node, child2);
      }
      var cp = node.parentNode;
      if (cp) {
        cp.removeChild(node);
      }
      if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
        var newFirst = node.firstChild;
        if (newFirst == null) {
          return node;
        }
        var newLast = node.lastChild;
      } else {
        newFirst = newLast = node;
      }
      var pre = child2 ? child2.previousSibling : parent.lastChild;
      newFirst.previousSibling = pre;
      newLast.nextSibling = child2;
      if (pre) {
        pre.nextSibling = newFirst;
      } else {
        parent.firstChild = newFirst;
      }
      if (child2 == null) {
        parent.lastChild = newLast;
      } else {
        child2.previousSibling = newLast;
      }
      do {
        newFirst.parentNode = parent;
      } while (newFirst !== newLast && (newFirst = newFirst.nextSibling));
      _onUpdateChild(parent.ownerDocument || parent, parent, node);
      if (node.nodeType == DOCUMENT_FRAGMENT_NODE) {
        node.firstChild = node.lastChild = null;
      }
      return node;
    }
    Document.prototype = {
      /**
       * The implementation that created this document.
       *
       * @type DOMImplementation
       * @readonly
       */
      implementation: null,
      nodeName: "#document",
      nodeType: DOCUMENT_NODE,
      /**
       * The DocumentType node of the document.
       *
       * @type DocumentType
       * @readonly
       */
      doctype: null,
      documentElement: null,
      _inc: 1,
      insertBefore: function(newChild, refChild) {
        if (newChild.nodeType === DOCUMENT_FRAGMENT_NODE) {
          var child2 = newChild.firstChild;
          while (child2) {
            var next = child2.nextSibling;
            this.insertBefore(child2, refChild);
            child2 = next;
          }
          return newChild;
        }
        _insertBefore(this, newChild, refChild);
        newChild.ownerDocument = this;
        if (this.documentElement === null && newChild.nodeType === ELEMENT_NODE) {
          this.documentElement = newChild;
        }
        return newChild;
      },
      removeChild: function(oldChild) {
        var removed = _removeChild(this, oldChild);
        if (removed === this.documentElement) {
          this.documentElement = null;
        }
        return removed;
      },
      replaceChild: function(newChild, oldChild) {
        _insertBefore(this, newChild, oldChild, assertPreReplacementValidityInDocument);
        newChild.ownerDocument = this;
        if (oldChild) {
          this.removeChild(oldChild);
        }
        if (isElementNode(newChild)) {
          this.documentElement = newChild;
        }
      },
      /**
       * Imports a node from another document into this document, creating a new copy owned by this
       * document. The source node and its subtree are not modified.
       *
       * @param {Node} importedNode
       * The node to import.
       * @param {boolean} deep
       * If true, the contents of the node are recursively imported.
       * If false, only the node itself (and its attributes, if it is an element) are imported.
       * @returns {Node}
       * Returns the newly created import of the node.
       * @see {@link importNode}
       * @see {@link https://dom.spec.whatwg.org/#dom-document-importnode}
       */
      importNode: function(importedNode, deep) {
        return importNode(this, importedNode, deep);
      },
      // Introduced in DOM Level 2:
      getElementById: function(id) {
        var rtv = null;
        _visitNode(this.documentElement, function(node) {
          if (node.nodeType == ELEMENT_NODE) {
            if (node.getAttribute("id") == id) {
              rtv = node;
              return true;
            }
          }
        });
        return rtv;
      },
      /**
       * Creates a new `Element` that is owned by this `Document`.
       * In HTML Documents `localName` is the lower cased `tagName`,
       * otherwise no transformation is being applied.
       * When `contentType` implies the HTML namespace, it will be set as `namespaceURI`.
       *
       * __This implementation differs from the specification:__ - The provided name is not checked
       * against the `Name` production,
       * so no related error will be thrown.
       * - There is no interface `HTMLElement`, it is always an `Element`.
       * - There is no support for a second argument to indicate using custom elements.
       *
       * @param {string} tagName
       * @returns {Element}
       * @see https://developer.mozilla.org/en-US/docs/Web/API/Document/createElement
       * @see https://dom.spec.whatwg.org/#dom-document-createelement
       * @see https://dom.spec.whatwg.org/#concept-create-element
       */
      createElement: function(tagName) {
        var node = new Element(PDC);
        node.ownerDocument = this;
        if (this.type === "html") {
          tagName = tagName.toLowerCase();
        }
        if (hasDefaultHTMLNamespace(this.contentType)) {
          node.namespaceURI = NAMESPACE.HTML;
        }
        node.nodeName = tagName;
        node.tagName = tagName;
        node.localName = tagName;
        node.childNodes = new NodeList();
        var attrs = node.attributes = new NamedNodeMap();
        attrs._ownerElement = node;
        return node;
      },
      /**
       * @returns {DocumentFragment}
       */
      createDocumentFragment: function() {
        var node = new DocumentFragment(PDC);
        node.ownerDocument = this;
        node.childNodes = new NodeList();
        return node;
      },
      /**
       * @param {string} data
       * @returns {Text}
       */
      createTextNode: function(data) {
        var node = new Text(PDC);
        node.ownerDocument = this;
        node.childNodes = new NodeList();
        node.appendData(data);
        return node;
      },
      /**
       * @param {string} data
       * @returns {Comment}
       * @see https://dom.spec.whatwg.org/#dom-document-createcomment
       * @see https://www.w3.org/TR/xml/#NT-Comment XML 1.0 production [15]
       * @see https://www.w3.org/TR/DOM-Parsing/#dfn-concept-serialize-xml §3.2.1.3
       *
       *      Note: no validation is performed at creation time. When the resulting document is
       *      serialized with `requireWellFormed: true`, the serializer throws `InvalidStateError`
       *      if the comment data contains `--` anywhere, ends with `-`, or contains characters
       *      outside the XML Char production (W3C DOM Parsing §3.2.1.3). Without that option the
       *      data is emitted verbatim.
       */
      createComment: function(data) {
        var node = new Comment(PDC);
        node.ownerDocument = this;
        node.childNodes = new NodeList();
        node.appendData(data);
        return node;
      },
      /**
       * Returns a new CDATASection node whose data is `data`.
       *
       * __This implementation differs from the specification:__ - calling this method on an HTML
       * document does not throw `NotSupportedError`.
       *
       * @param {string} data
       * @returns {CDATASection}
       * @throws {DOMException}
       * With code `INVALID_CHARACTER_ERR` if `data` contains `"]]>"`.
       * @see https://developer.mozilla.org/en-US/docs/Web/API/Document/createCDATASection
       * @see https://dom.spec.whatwg.org/#dom-document-createcdatasection
       */
      createCDATASection: function(data) {
        if (data.indexOf("]]>") !== -1) {
          throw new DOMException(DOMException.INVALID_CHARACTER_ERR, 'data contains "]]>"');
        }
        var node = new CDATASection(PDC);
        node.ownerDocument = this;
        node.childNodes = new NodeList();
        node.appendData(data);
        return node;
      },
      /**
       * Returns a ProcessingInstruction node whose target is target and data is data.
       *
       * __This behavior is slightly different from the in the specs__:
       * - it does not do any input validation on the arguments and doesn't throw
       * "InvalidCharacterError".
       *
       * Note: When the resulting document is serialized with `requireWellFormed: true`, the
       * serializer throws `InvalidStateError` if `.target` is not a valid XML `NCName` (a `Name`
       * with no colon) or is an ASCII case-insensitive match for `"xml"`, or if `.data` contains
       * `?>` or characters outside the XML Char production (W3C DOM Parsing §3.2.1.7). Without that
       * option the target and data are emitted verbatim.
       *
       * @param {string} target
       * @param {string} data
       * @returns {ProcessingInstruction}
       * @see https://developer.mozilla.org/docs/Web/API/Document/createProcessingInstruction
       * @see https://dom.spec.whatwg.org/#dom-document-createprocessinginstruction
       * @see https://www.w3.org/TR/DOM-Parsing/#dfn-concept-serialize-xml §3.2.1.7
       */
      createProcessingInstruction: function(target, data) {
        var node = new ProcessingInstruction(PDC);
        node.ownerDocument = this;
        node.childNodes = new NodeList();
        node.nodeName = node.target = target;
        node.nodeValue = node.data = data;
        return node;
      },
      /**
       * Creates an `Attr` node that is owned by this document.
       * In HTML Documents `localName` is the lower cased `name`,
       * otherwise no transformation is being applied.
       *
       * __This implementation differs from the specification:__ - The provided name is not checked
       * against the `Name` production,
       * so no related error will be thrown.
       *
       * @param {string} name
       * @returns {Attr}
       * @see https://developer.mozilla.org/en-US/docs/Web/API/Document/createAttribute
       * @see https://dom.spec.whatwg.org/#dom-document-createattribute
       */
      createAttribute: function(name) {
        if (!g.QName_exact.test(name)) {
          throw new DOMException(DOMException.INVALID_CHARACTER_ERR, 'invalid character in name "' + name + '"');
        }
        if (this.type === "html") {
          name = name.toLowerCase();
        }
        return this._createAttribute(name);
      },
      _createAttribute: function(name) {
        var node = new Attr(PDC);
        node.ownerDocument = this;
        node.childNodes = new NodeList();
        node.name = name;
        node.nodeName = name;
        node.localName = name;
        node.specified = true;
        return node;
      },
      /**
       * Creates an EntityReference object.
       * The current implementation does not fill the `childNodes` with those of the corresponding
       * `Entity`
       *
       * The `name` is validated against the XML `Name` production at creation time; an invalid name
       * throws `InvalidCharacterError`. When the resulting node is serialized with
       * `requireWellFormed: true`, the serializer re-validates `nodeName` against the XML `Name`
       * production and throws `InvalidStateError` if a later `nodeName` mutation made it invalid;
       * without that option the name is emitted verbatim.
       *
       * __This implementation differs from the specification:__ xmldom does not expand entities —
       * the parser resolves entity references inline and never constructs `EntityReference` nodes,
       * so this method is the only producer.
       *
       * @deprecated
       * In DOM Level 4.
       * @param {string} name
       * The name of the entity to reference. No namespace well-formedness checks are performed.
       * @returns {EntityReference}
       * @throws {DOMException}
       * With code `INVALID_CHARACTER_ERR` when `name` is not a valid XML `Name`.
       * @throws {DOMException}
       * with code `NOT_SUPPORTED_ERR` when the document is of type `html`
       * @see https://www.w3.org/TR/DOM-Level-3-Core/core.html#ID-392B75AE
       */
      createEntityReference: function(name) {
        if (!g.Name_exact.test(name)) {
          throw new DOMException(DOMException.INVALID_CHARACTER_ERR, 'not a valid xml name "' + name + '"');
        }
        if (this.type === "html") {
          throw new DOMException("document is an html document", DOMExceptionName.NotSupportedError);
        }
        var node = new EntityReference(PDC);
        node.ownerDocument = this;
        node.childNodes = new NodeList();
        node.nodeName = name;
        return node;
      },
      // Introduced in DOM Level 2:
      /**
       * @param {string} namespaceURI
       * @param {string} qualifiedName
       * @returns {Element}
       */
      createElementNS: function(namespaceURI, qualifiedName) {
        var validated = validateAndExtract(namespaceURI, qualifiedName);
        var node = new Element(PDC);
        var attrs = node.attributes = new NamedNodeMap();
        node.childNodes = new NodeList();
        node.ownerDocument = this;
        node.nodeName = qualifiedName;
        node.tagName = qualifiedName;
        node.namespaceURI = validated[0];
        node.prefix = validated[1];
        node.localName = validated[2];
        attrs._ownerElement = node;
        return node;
      },
      // Introduced in DOM Level 2:
      /**
       * @param {string} namespaceURI
       * @param {string} qualifiedName
       * @returns {Attr}
       */
      createAttributeNS: function(namespaceURI, qualifiedName) {
        var validated = validateAndExtract(namespaceURI, qualifiedName);
        var node = new Attr(PDC);
        node.ownerDocument = this;
        node.childNodes = new NodeList();
        node.nodeName = qualifiedName;
        node.name = qualifiedName;
        node.specified = true;
        node.namespaceURI = validated[0];
        node.prefix = validated[1];
        node.localName = validated[2];
        return node;
      }
    };
    _extends(Document, Node);
    function Element(symbol) {
      checkSymbol(symbol);
      this._nsMap = /* @__PURE__ */ Object.create(null);
    }
    Element.prototype = {
      nodeType: ELEMENT_NODE,
      /**
       * The attributes of this element.
       *
       * @type {NamedNodeMap | null}
       */
      attributes: null,
      getQualifiedName: function() {
        return this.prefix ? this.prefix + ":" + this.localName : this.localName;
      },
      _isInHTMLDocumentAndNamespace: function() {
        return this.ownerDocument.type === "html" && this.namespaceURI === NAMESPACE.HTML;
      },
      /**
       * Implementaton of Level2 Core function hasAttributes.
       *
       * @returns {boolean}
       * True if attribute list is not empty.
       * @see https://www.w3.org/TR/DOM-Level-2-Core/#core-ID-NodeHasAttrs
       */
      hasAttributes: function() {
        return !!(this.attributes && this.attributes.length);
      },
      hasAttribute: function(name) {
        return !!this.getAttributeNode(name);
      },
      /**
       * Returns element’s first attribute whose qualified name is `name`, and `null`
       * if there is no such attribute.
       *
       * @param {string} name
       * @returns {string | null}
       */
      getAttribute: function(name) {
        var attr = this.getAttributeNode(name);
        return attr ? attr.value : null;
      },
      getAttributeNode: function(name) {
        if (this._isInHTMLDocumentAndNamespace()) {
          name = name.toLowerCase();
        }
        return this.attributes.getNamedItem(name);
      },
      /**
       * Sets the value of element’s first attribute whose qualified name is qualifiedName to value.
       *
       * @param {string} name
       * @param {string} value
       */
      setAttribute: function(name, value) {
        if (this._isInHTMLDocumentAndNamespace()) {
          name = name.toLowerCase();
        }
        var attr = this.getAttributeNode(name);
        if (attr) {
          attr.value = attr.nodeValue = "" + value;
        } else {
          attr = this.ownerDocument._createAttribute(name);
          attr.value = attr.nodeValue = "" + value;
          this.setAttributeNode(attr);
        }
      },
      removeAttribute: function(name) {
        var attr = this.getAttributeNode(name);
        attr && this.removeAttributeNode(attr);
      },
      setAttributeNode: function(newAttr) {
        return this.attributes.setNamedItem(newAttr);
      },
      setAttributeNodeNS: function(newAttr) {
        return this.attributes.setNamedItemNS(newAttr);
      },
      removeAttributeNode: function(oldAttr) {
        return this.attributes.removeNamedItem(oldAttr.nodeName);
      },
      //get real attribute name,and remove it by removeAttributeNode
      removeAttributeNS: function(namespaceURI, localName) {
        var old = this.getAttributeNodeNS(namespaceURI, localName);
        old && this.removeAttributeNode(old);
      },
      hasAttributeNS: function(namespaceURI, localName) {
        return this.getAttributeNodeNS(namespaceURI, localName) != null;
      },
      /**
       * Returns element’s attribute whose namespace is `namespaceURI` and local name is
       * `localName`,
       * or `null` if there is no such attribute.
       *
       * @param {string} namespaceURI
       * @param {string} localName
       * @returns {string | null}
       */
      getAttributeNS: function(namespaceURI, localName) {
        var attr = this.getAttributeNodeNS(namespaceURI, localName);
        return attr ? attr.value : null;
      },
      /**
       * Sets the value of element’s attribute whose namespace is `namespaceURI` and local name is
       * `localName` to value.
       *
       * @param {string} namespaceURI
       * @param {string} qualifiedName
       * @param {string} value
       * @see https://dom.spec.whatwg.org/#dom-element-setattributens
       */
      setAttributeNS: function(namespaceURI, qualifiedName, value) {
        var validated = validateAndExtract(namespaceURI, qualifiedName);
        var localName = validated[2];
        var attr = this.getAttributeNodeNS(namespaceURI, localName);
        if (attr) {
          attr.value = attr.nodeValue = "" + value;
        } else {
          attr = this.ownerDocument.createAttributeNS(namespaceURI, qualifiedName);
          attr.value = attr.nodeValue = "" + value;
          this.setAttributeNode(attr);
        }
      },
      getAttributeNodeNS: function(namespaceURI, localName) {
        return this.attributes.getNamedItemNS(namespaceURI, localName);
      },
      /**
       * Returns a LiveNodeList of all child elements which have **all** of the given class name(s).
       *
       * Returns an empty list if `classNames` is an empty string or only contains HTML white space
       * characters.
       *
       * Warning: This returns a live LiveNodeList.
       * Changes in the DOM will reflect in the array as the changes occur.
       * If an element selected by this array no longer qualifies for the selector,
       * it will automatically be removed. Be aware of this for iteration purposes.
       *
       * @param {string} classNames
       * Is a string representing the class name(s) to match; multiple class names are separated by
       * (ASCII-)whitespace.
       * @see https://developer.mozilla.org/en-US/docs/Web/API/Element/getElementsByClassName
       * @see https://developer.mozilla.org/en-US/docs/Web/API/Document/getElementsByClassName
       * @see https://dom.spec.whatwg.org/#concept-getelementsbyclassname
       */
      getElementsByClassName: function(classNames) {
        var classNamesSet = toOrderedSet(classNames);
        return new LiveNodeList(this, function(base) {
          var ls = [];
          if (classNamesSet.length > 0) {
            _visitNode(base, function(node) {
              if (node !== base && node.nodeType === ELEMENT_NODE) {
                var nodeClassNames = node.getAttribute("class");
                if (nodeClassNames) {
                  var matches = classNames === nodeClassNames;
                  if (!matches) {
                    var nodeClassNamesSet = toOrderedSet(nodeClassNames);
                    matches = classNamesSet.every(arrayIncludes(nodeClassNamesSet));
                  }
                  if (matches) {
                    ls.push(node);
                  }
                }
              }
            });
          }
          return ls;
        });
      },
      /**
       * Returns a LiveNodeList of elements with the given qualifiedName.
       * Searching for all descendants can be done by passing `*` as `qualifiedName`.
       *
       * All descendants of the specified element are searched, but not the element itself.
       * The returned list is live, which means it updates itself with the DOM tree automatically.
       * Therefore, there is no need to call `Element.getElementsByTagName()`
       * with the same element and arguments repeatedly if the DOM changes in between calls.
       *
       * When called on an HTML element in an HTML document,
       * `getElementsByTagName` lower-cases the argument before searching for it.
       * This is undesirable when trying to match camel-cased SVG elements (such as
       * `<linearGradient>`) in an HTML document.
       * Instead, use `Element.getElementsByTagNameNS()`,
       * which preserves the capitalization of the tag name.
       *
       * `Element.getElementsByTagName` is similar to `Document.getElementsByTagName()`,
       * except that it only searches for elements that are descendants of the specified element.
       *
       * @param {string} qualifiedName
       * @returns {LiveNodeList}
       * @see https://developer.mozilla.org/en-US/docs/Web/API/Element/getElementsByTagName
       * @see https://dom.spec.whatwg.org/#concept-getelementsbytagname
       */
      getElementsByTagName: function(qualifiedName) {
        var isHTMLDocument = (this.nodeType === DOCUMENT_NODE ? this : this.ownerDocument).type === "html";
        var lowerQualifiedName = qualifiedName.toLowerCase();
        return new LiveNodeList(this, function(base) {
          var ls = [];
          _visitNode(base, function(node) {
            if (node === base || node.nodeType !== ELEMENT_NODE) {
              return;
            }
            if (qualifiedName === "*") {
              ls.push(node);
            } else {
              var nodeQualifiedName = node.getQualifiedName();
              var matchingQName = isHTMLDocument && node.namespaceURI === NAMESPACE.HTML ? lowerQualifiedName : qualifiedName;
              if (nodeQualifiedName === matchingQName) {
                ls.push(node);
              }
            }
          });
          return ls;
        });
      },
      getElementsByTagNameNS: function(namespaceURI, localName) {
        return new LiveNodeList(this, function(base) {
          var ls = [];
          _visitNode(base, function(node) {
            if (node !== base && node.nodeType === ELEMENT_NODE && (namespaceURI === "*" || node.namespaceURI === namespaceURI) && (localName === "*" || node.localName == localName)) {
              ls.push(node);
            }
          });
          return ls;
        });
      }
    };
    Document.prototype.getElementsByClassName = Element.prototype.getElementsByClassName;
    Document.prototype.getElementsByTagName = Element.prototype.getElementsByTagName;
    Document.prototype.getElementsByTagNameNS = Element.prototype.getElementsByTagNameNS;
    _extends(Element, Node);
    function Attr(symbol) {
      checkSymbol(symbol);
      this.namespaceURI = null;
      this.prefix = null;
      this.ownerElement = null;
    }
    Attr.prototype.nodeType = ATTRIBUTE_NODE;
    _extends(Attr, Node);
    function CharacterData(symbol) {
      checkSymbol(symbol);
    }
    CharacterData.prototype = {
      data: "",
      substringData: function(offset, count) {
        return this.data.substring(offset, offset + count);
      },
      appendData: function(text) {
        text = this.data + text;
        this.nodeValue = this.data = text;
        this.length = text.length;
      },
      insertData: function(offset, text) {
        this.replaceData(offset, 0, text);
      },
      deleteData: function(offset, count) {
        this.replaceData(offset, count, "");
      },
      replaceData: function(offset, count, text) {
        var start = this.data.substring(0, offset);
        var end = this.data.substring(offset + count);
        text = start + text + end;
        this.nodeValue = this.data = text;
        this.length = text.length;
      }
    };
    _extends(CharacterData, Node);
    function Text(symbol) {
      checkSymbol(symbol);
    }
    Text.prototype = {
      nodeName: "#text",
      nodeType: TEXT_NODE,
      splitText: function(offset) {
        var text = this.data;
        var newText = text.substring(offset);
        text = text.substring(0, offset);
        this.data = this.nodeValue = text;
        this.length = text.length;
        var newNode = this.ownerDocument.createTextNode(newText);
        if (this.parentNode) {
          this.parentNode.insertBefore(newNode, this.nextSibling);
        }
        return newNode;
      }
    };
    _extends(Text, CharacterData);
    function Comment(symbol) {
      checkSymbol(symbol);
    }
    Comment.prototype = {
      nodeName: "#comment",
      nodeType: COMMENT_NODE
    };
    _extends(Comment, CharacterData);
    function CDATASection(symbol) {
      checkSymbol(symbol);
    }
    CDATASection.prototype = {
      nodeName: "#cdata-section",
      nodeType: CDATA_SECTION_NODE
    };
    _extends(CDATASection, Text);
    function DocumentType(symbol) {
      checkSymbol(symbol);
    }
    DocumentType.prototype.nodeType = DOCUMENT_TYPE_NODE;
    _extends(DocumentType, Node);
    function Notation(symbol) {
      checkSymbol(symbol);
    }
    Notation.prototype.nodeType = NOTATION_NODE;
    _extends(Notation, Node);
    function Entity(symbol) {
      checkSymbol(symbol);
    }
    Entity.prototype.nodeType = ENTITY_NODE;
    _extends(Entity, Node);
    function EntityReference(symbol) {
      checkSymbol(symbol);
    }
    EntityReference.prototype.nodeType = ENTITY_REFERENCE_NODE;
    _extends(EntityReference, Node);
    function DocumentFragment(symbol) {
      checkSymbol(symbol);
    }
    DocumentFragment.prototype.nodeName = "#document-fragment";
    DocumentFragment.prototype.nodeType = DOCUMENT_FRAGMENT_NODE;
    _extends(DocumentFragment, Node);
    function ProcessingInstruction(symbol) {
      checkSymbol(symbol);
    }
    ProcessingInstruction.prototype.nodeType = PROCESSING_INSTRUCTION_NODE;
    _extends(ProcessingInstruction, CharacterData);
    function XMLSerializer2() {
    }
    XMLSerializer2.prototype.serializeToString = function(node, options) {
      return nodeSerializeToString.call(node, options);
    };
    Node.prototype.toString = nodeSerializeToString;
    function nodeSerializeToString(options) {
      var opts;
      if (typeof options === "function") {
        opts = { requireWellFormed: false, splitCDATASections: true, nodeFilter: options };
      } else if (options != null) {
        opts = {
          requireWellFormed: !!options.requireWellFormed,
          splitCDATASections: options.splitCDATASections !== false,
          nodeFilter: options.nodeFilter || null
        };
      } else {
        opts = { requireWellFormed: false, splitCDATASections: true, nodeFilter: null };
      }
      var buf = [];
      var refNode = this.nodeType === DOCUMENT_NODE && this.documentElement || this;
      var prefix = refNode.prefix;
      var uri = refNode.namespaceURI;
      if (uri && prefix == null) {
        var prefix = refNode.lookupPrefix(uri);
        if (prefix == null) {
          var visibleNamespaces = [
            { namespace: uri, prefix: null }
            //{namespace:uri,prefix:''}
          ];
        }
      }
      serializeToString(this, buf, visibleNamespaces, opts);
      return buf.join("");
    }
    function needNamespaceDefine(node, isHTML, visibleNamespaces) {
      var prefix = node.prefix || "";
      var uri = node.namespaceURI;
      if (!uri) {
        return false;
      }
      if (prefix === "xml" && uri === NAMESPACE.XML || uri === NAMESPACE.XMLNS) {
        return false;
      }
      var i = visibleNamespaces.length;
      while (i--) {
        var ns = visibleNamespaces[i];
        if (ns.prefix === prefix) {
          return ns.namespace !== uri;
        }
      }
      return true;
    }
    function addSerializedAttribute(buf, qualifiedName, value, requireWellFormed) {
      if (requireWellFormed && !g.QName_exact.test(qualifiedName)) {
        throw new DOMException(
          'The attribute name "' + qualifiedName + '" is not a valid XML QName',
          DOMExceptionName.InvalidStateError
        );
      }
      buf.push(" ", qualifiedName, '="', value.replace(/[<>&"\t\n\r]/g, _xmlEncoder), '"');
    }
    function serializeToString(node, buf, visibleNamespaces, opts) {
      if (!visibleNamespaces) {
        visibleNamespaces = [];
      }
      var nodeFilter = opts.nodeFilter;
      var requireWellFormed = opts.requireWellFormed;
      var splitCDATASections = opts.splitCDATASections;
      var doc = node.nodeType === DOCUMENT_NODE ? node : node.ownerDocument;
      var isHTML = doc.type === "html";
      walkDOM(
        node,
        { ns: visibleNamespaces },
        {
          enter: function(n, ctx) {
            var namespaces = ctx.ns;
            if (nodeFilter) {
              n = nodeFilter(n);
              if (n) {
                if (typeof n == "string") {
                  buf.push(n);
                  return null;
                }
              } else {
                return null;
              }
            }
            switch (n.nodeType) {
              case ELEMENT_NODE:
                var attrs = n.attributes;
                var len = attrs.length;
                var nodeName = n.tagName;
                var prefixedNodeName = nodeName;
                if (!isHTML && !n.prefix && n.namespaceURI) {
                  var defaultNS;
                  for (var ai = 0; ai < attrs.length; ai++) {
                    if (attrs.item(ai).name === "xmlns") {
                      defaultNS = attrs.item(ai).value;
                      break;
                    }
                  }
                  if (!defaultNS) {
                    for (var nsi = namespaces.length - 1; nsi >= 0; nsi--) {
                      var nsEntry = namespaces[nsi];
                      if (nsEntry.prefix === "" && nsEntry.namespace === n.namespaceURI) {
                        defaultNS = nsEntry.namespace;
                        break;
                      }
                    }
                  }
                  if (defaultNS !== n.namespaceURI) {
                    for (var nsi = namespaces.length - 1; nsi >= 0; nsi--) {
                      var nsEntry = namespaces[nsi];
                      if (nsEntry.namespace === n.namespaceURI) {
                        if (nsEntry.prefix) {
                          prefixedNodeName = nsEntry.prefix + ":" + nodeName;
                        }
                        break;
                      }
                    }
                  }
                }
                if (requireWellFormed && !g.QName_exact.test(prefixedNodeName)) {
                  throw new DOMException(
                    'The element name "' + prefixedNodeName + '" is not a valid XML QName',
                    DOMExceptionName.InvalidStateError
                  );
                }
                buf.push("<", prefixedNodeName);
                var childNamespaces = namespaces.slice();
                for (var i = 0; i < len; i++) {
                  var attr = attrs.item(i);
                  if (attr.prefix == "xmlns") {
                    childNamespaces.push({
                      prefix: attr.localName,
                      namespace: attr.value
                    });
                  } else if (attr.nodeName == "xmlns") {
                    childNamespaces.push({ prefix: "", namespace: attr.value });
                  }
                }
                for (var i = 0; i < len; i++) {
                  var attr = attrs.item(i);
                  if (needNamespaceDefine(attr, isHTML, childNamespaces)) {
                    var attrPrefix = attr.prefix || "";
                    var uri = attr.namespaceURI;
                    addSerializedAttribute(buf, attrPrefix ? "xmlns:" + attrPrefix : "xmlns", uri, requireWellFormed);
                    childNamespaces.push({ prefix: attrPrefix, namespace: uri });
                  }
                  var filteredAttr = nodeFilter ? nodeFilter(attr) : attr;
                  if (filteredAttr) {
                    if (typeof filteredAttr === "string") {
                      buf.push(filteredAttr);
                    } else {
                      addSerializedAttribute(buf, filteredAttr.name, filteredAttr.value, requireWellFormed);
                    }
                  }
                }
                if (nodeName === prefixedNodeName && needNamespaceDefine(n, isHTML, childNamespaces)) {
                  var nodePrefix = n.prefix || "";
                  var uri = n.namespaceURI;
                  addSerializedAttribute(buf, nodePrefix ? "xmlns:" + nodePrefix : "xmlns", uri, requireWellFormed);
                  childNamespaces.push({ prefix: nodePrefix, namespace: uri });
                }
                var canCloseTag = !n.firstChild;
                if (canCloseTag && (isHTML || n.namespaceURI === NAMESPACE.HTML)) {
                  canCloseTag = isHTMLVoidElement(nodeName);
                }
                if (canCloseTag) {
                  buf.push("/>");
                  return null;
                }
                buf.push(">");
                if (isHTML && isHTMLRawTextElement(nodeName)) {
                  var child2 = n.firstChild;
                  while (child2) {
                    if (child2.data) {
                      buf.push(child2.data);
                    } else {
                      serializeToString(child2, buf, childNamespaces.slice(), opts);
                    }
                    child2 = child2.nextSibling;
                  }
                  buf.push("</", prefixedNodeName, ">");
                  return null;
                }
                return { ns: childNamespaces, tag: prefixedNodeName };
              case DOCUMENT_NODE:
              case DOCUMENT_FRAGMENT_NODE:
                if (requireWellFormed && n.nodeType === DOCUMENT_NODE && n.documentElement == null) {
                  throw new DOMException("The Document has no documentElement", DOMExceptionName.InvalidStateError);
                }
                return { ns: namespaces };
              case ATTRIBUTE_NODE:
                addSerializedAttribute(buf, n.name, n.value, requireWellFormed);
                return null;
              case TEXT_NODE:
                if (requireWellFormed && g.InvalidChar.test(n.data)) {
                  throw new DOMException(
                    "The Text node data contains characters outside the XML Char production",
                    DOMExceptionName.InvalidStateError
                  );
                }
                buf.push(n.data.replace(/[<&>]/g, _xmlEncoder));
                return null;
              case CDATA_SECTION_NODE:
                if (requireWellFormed && n.data.indexOf("]]>") !== -1) {
                  throw new DOMException('The CDATASection data contains "]]>"', DOMExceptionName.InvalidStateError);
                }
                if (splitCDATASections) {
                  buf.push(g.CDATA_START, n.data.replace(/]]>/g, "]]]]><![CDATA[>"), g.CDATA_END);
                } else {
                  buf.push(g.CDATA_START, n.data, g.CDATA_END);
                }
                return null;
              case COMMENT_NODE:
                if (requireWellFormed) {
                  if (g.InvalidChar.test(n.data)) {
                    throw new DOMException(
                      "The comment node data contains characters outside the XML Char production",
                      DOMExceptionName.InvalidStateError
                    );
                  }
                  if (n.data.indexOf("--") !== -1 || n.data[n.data.length - 1] === "-") {
                    throw new DOMException(
                      'The comment node data contains "--" or ends with "-"',
                      DOMExceptionName.InvalidStateError
                    );
                  }
                }
                buf.push(g.COMMENT_START, n.data, g.COMMENT_END);
                return null;
              case DOCUMENT_TYPE_NODE:
                var pubid = n.publicId;
                var sysid = n.systemId;
                if (requireWellFormed) {
                  if (!g.Name_exact.test(n.name)) {
                    throw new DOMException(
                      'The doctype name "' + n.name + '" is not a valid XML Name',
                      DOMExceptionName.InvalidStateError
                    );
                  }
                  if (pubid && !g.PubidLiteral_match.test(pubid)) {
                    throw new DOMException("DocumentType publicId is not a valid PubidLiteral", DOMExceptionName.InvalidStateError);
                  }
                  if (sysid && sysid !== "." && !g.SystemLiteral_match.test(sysid)) {
                    throw new DOMException("DocumentType systemId is not a valid SystemLiteral", DOMExceptionName.InvalidStateError);
                  }
                  if (n.internalSubset && n.internalSubset.indexOf("]>") !== -1) {
                    throw new DOMException('DocumentType internalSubset contains "]>"', DOMExceptionName.InvalidStateError);
                  }
                }
                buf.push(g.DOCTYPE_DECL_START, " ", n.name);
                if (pubid) {
                  buf.push(" ", g.PUBLIC, " ", pubid);
                  if (sysid && sysid !== ".") {
                    buf.push(" ", sysid);
                  }
                } else if (sysid && sysid !== ".") {
                  buf.push(" ", g.SYSTEM, " ", sysid);
                }
                if (n.internalSubset) {
                  buf.push(" [", n.internalSubset, "]");
                }
                buf.push(">");
                return null;
              case PROCESSING_INSTRUCTION_NODE:
                if (requireWellFormed) {
                  if (!g.NCName_exact.test(n.target) || n.target.toLowerCase() === "xml") {
                    throw new DOMException(
                      'The processing instruction target "' + n.target + '" is not a valid XML NCName or is reserved',
                      DOMExceptionName.InvalidStateError
                    );
                  }
                  if (g.InvalidChar.test(n.data)) {
                    throw new DOMException(
                      "The ProcessingInstruction data contains characters outside the XML Char production",
                      DOMExceptionName.InvalidStateError
                    );
                  }
                  if (n.data.indexOf("?>") !== -1) {
                    throw new DOMException('The ProcessingInstruction data contains "?>"', DOMExceptionName.InvalidStateError);
                  }
                }
                buf.push("<?", n.target, " ", n.data, "?>");
                return null;
              case ENTITY_REFERENCE_NODE:
                if (requireWellFormed && !g.Name_exact.test(n.nodeName)) {
                  throw new DOMException(
                    'The entity reference name "' + n.nodeName + '" is not a valid XML Name',
                    DOMExceptionName.InvalidStateError
                  );
                }
                buf.push("&", n.nodeName, ";");
                return null;
              //case ENTITY_NODE:
              //case NOTATION_NODE:
              default:
                buf.push("??", n.nodeName);
                return null;
            }
          },
          exit: function(n, childCtx) {
            if (childCtx && childCtx.tag) {
              buf.push("</", childCtx.tag, ">");
            }
          }
        }
      );
    }
    function importNode(doc, node, deep) {
      var destRoot;
      walkDOM(node, null, {
        enter: function(srcNode, destParent) {
          var destNode = srcNode.cloneNode(false);
          destNode.ownerDocument = doc;
          destNode.parentNode = null;
          if (destParent === null) {
            destRoot = destNode;
          } else {
            destParent.appendChild(destNode);
          }
          var shouldDeep = srcNode.nodeType === ATTRIBUTE_NODE || deep;
          return shouldDeep ? destNode : null;
        }
      });
      return destRoot;
    }
    function cloneNode(doc, node, deep) {
      var destRoot;
      walkDOM(node, null, {
        enter: function(srcNode, destParent) {
          var destNode = new srcNode.constructor(PDC);
          for (var n in srcNode) {
            if (hasOwn(srcNode, n)) {
              var v = srcNode[n];
              if (typeof v != "object") {
                if (v != destNode[n]) {
                  destNode[n] = v;
                }
              }
            }
          }
          if (srcNode.childNodes) {
            destNode.childNodes = new NodeList();
          }
          destNode.ownerDocument = doc;
          var shouldDeep = deep;
          switch (destNode.nodeType) {
            case ELEMENT_NODE:
              var attrs = srcNode.attributes;
              var attrs2 = destNode.attributes = new NamedNodeMap();
              var len = attrs.length;
              attrs2._ownerElement = destNode;
              for (var i = 0; i < len; i++) {
                destNode.setAttributeNode(cloneNode(doc, attrs.item(i), true));
              }
              break;
            case ATTRIBUTE_NODE:
              shouldDeep = true;
          }
          if (destParent !== null) {
            destParent.appendChild(destNode);
          } else {
            destRoot = destNode;
          }
          return shouldDeep ? destNode : null;
        }
      });
      return destRoot;
    }
    function __set__(object, key, value) {
      object[key] = value;
    }
    function childrenRefresh(node) {
      var ls = [];
      var child2 = node.firstChild;
      while (child2) {
        if (child2.nodeType === ELEMENT_NODE) {
          ls.push(child2);
        }
        child2 = child2.nextSibling;
      }
      return ls;
    }
    try {
      if (Object.defineProperty) {
        Object.defineProperty(LiveNodeList.prototype, "length", {
          get: function() {
            _updateLiveList(this);
            return this.$$length;
          }
        });
        Object.defineProperty(Node.prototype, "textContent", {
          get: function() {
            if (this.nodeType === ELEMENT_NODE || this.nodeType === DOCUMENT_FRAGMENT_NODE) {
              var buf = [];
              walkDOM(this, null, {
                enter: function(n) {
                  if (n.nodeType === ELEMENT_NODE || n.nodeType === DOCUMENT_FRAGMENT_NODE) {
                    return true;
                  }
                  if (n.nodeType === PROCESSING_INSTRUCTION_NODE || n.nodeType === COMMENT_NODE) {
                    return null;
                  }
                  buf.push(n.nodeValue);
                }
              });
              return buf.join("");
            }
            return this.nodeValue;
          },
          set: function(data) {
            switch (this.nodeType) {
              case ELEMENT_NODE:
              case DOCUMENT_FRAGMENT_NODE:
                while (this.firstChild) {
                  this.removeChild(this.firstChild);
                }
                if (data || String(data)) {
                  this.appendChild(this.ownerDocument.createTextNode(data));
                }
                break;
              default:
                this.data = data;
                this.value = data;
                this.nodeValue = data;
            }
          }
        });
        Object.defineProperty(CharacterData.prototype, "data", {
          get: function() {
            return this._data != null ? this._data : "";
          },
          set: function(v) {
            this._data = v;
            this.length = typeof v === "string" ? v.length : 0;
          }
        });
        Object.defineProperty(CharacterData.prototype, "nodeValue", {
          get: function() {
            return this.data;
          },
          set: function(v) {
            this.data = v;
          },
          enumerable: true,
          configurable: true
        });
        Object.defineProperty(Element.prototype, "children", {
          get: function() {
            return new LiveNodeList(this, childrenRefresh);
          }
        });
        Object.defineProperty(Document.prototype, "children", {
          get: function() {
            return new LiveNodeList(this, childrenRefresh);
          }
        });
        Object.defineProperty(DocumentFragment.prototype, "children", {
          get: function() {
            return new LiveNodeList(this, childrenRefresh);
          }
        });
        __set__ = function(object, key, value) {
          object["$$" + key] = value;
        };
      }
    } catch (e) {
    }
    exports._updateLiveList = _updateLiveList;
    exports.Attr = Attr;
    exports.CDATASection = CDATASection;
    exports.CharacterData = CharacterData;
    exports.Comment = Comment;
    exports.Document = Document;
    exports.DocumentFragment = DocumentFragment;
    exports.DocumentType = DocumentType;
    exports.DOMImplementation = DOMImplementation;
    exports.Element = Element;
    exports.Entity = Entity;
    exports.EntityReference = EntityReference;
    exports.LiveNodeList = LiveNodeList;
    exports.NamedNodeMap = NamedNodeMap;
    exports.Node = Node;
    exports.NodeList = NodeList;
    exports.Notation = Notation;
    exports.Text = Text;
    exports.ProcessingInstruction = ProcessingInstruction;
    exports.walkDOM = walkDOM;
    exports.XMLSerializer = XMLSerializer2;
  }
});

// node_modules/@xmldom/xmldom/lib/entities.js
var require_entities = __commonJS({
  "node_modules/@xmldom/xmldom/lib/entities.js"(exports) {
    "use strict";
    var freeze = require_conventions().freeze;
    exports.XML_ENTITIES = freeze({
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      quot: '"'
    });
    exports.HTML_ENTITIES = freeze({
      Aacute: "Á",
      aacute: "á",
      Abreve: "Ă",
      abreve: "ă",
      ac: "∾",
      acd: "∿",
      acE: "∾̳",
      Acirc: "Â",
      acirc: "â",
      acute: "´",
      Acy: "А",
      acy: "а",
      AElig: "Æ",
      aelig: "æ",
      af: "⁡",
      Afr: "𝔄",
      afr: "𝔞",
      Agrave: "À",
      agrave: "à",
      alefsym: "ℵ",
      aleph: "ℵ",
      Alpha: "Α",
      alpha: "α",
      Amacr: "Ā",
      amacr: "ā",
      amalg: "⨿",
      AMP: "&",
      amp: "&",
      And: "⩓",
      and: "∧",
      andand: "⩕",
      andd: "⩜",
      andslope: "⩘",
      andv: "⩚",
      ang: "∠",
      ange: "⦤",
      angle: "∠",
      angmsd: "∡",
      angmsdaa: "⦨",
      angmsdab: "⦩",
      angmsdac: "⦪",
      angmsdad: "⦫",
      angmsdae: "⦬",
      angmsdaf: "⦭",
      angmsdag: "⦮",
      angmsdah: "⦯",
      angrt: "∟",
      angrtvb: "⊾",
      angrtvbd: "⦝",
      angsph: "∢",
      angst: "Å",
      angzarr: "⍼",
      Aogon: "Ą",
      aogon: "ą",
      Aopf: "𝔸",
      aopf: "𝕒",
      ap: "≈",
      apacir: "⩯",
      apE: "⩰",
      ape: "≊",
      apid: "≋",
      apos: "'",
      ApplyFunction: "⁡",
      approx: "≈",
      approxeq: "≊",
      Aring: "Å",
      aring: "å",
      Ascr: "𝒜",
      ascr: "𝒶",
      Assign: "≔",
      ast: "*",
      asymp: "≈",
      asympeq: "≍",
      Atilde: "Ã",
      atilde: "ã",
      Auml: "Ä",
      auml: "ä",
      awconint: "∳",
      awint: "⨑",
      backcong: "≌",
      backepsilon: "϶",
      backprime: "‵",
      backsim: "∽",
      backsimeq: "⋍",
      Backslash: "∖",
      Barv: "⫧",
      barvee: "⊽",
      Barwed: "⌆",
      barwed: "⌅",
      barwedge: "⌅",
      bbrk: "⎵",
      bbrktbrk: "⎶",
      bcong: "≌",
      Bcy: "Б",
      bcy: "б",
      bdquo: "„",
      becaus: "∵",
      Because: "∵",
      because: "∵",
      bemptyv: "⦰",
      bepsi: "϶",
      bernou: "ℬ",
      Bernoullis: "ℬ",
      Beta: "Β",
      beta: "β",
      beth: "ℶ",
      between: "≬",
      Bfr: "𝔅",
      bfr: "𝔟",
      bigcap: "⋂",
      bigcirc: "◯",
      bigcup: "⋃",
      bigodot: "⨀",
      bigoplus: "⨁",
      bigotimes: "⨂",
      bigsqcup: "⨆",
      bigstar: "★",
      bigtriangledown: "▽",
      bigtriangleup: "△",
      biguplus: "⨄",
      bigvee: "⋁",
      bigwedge: "⋀",
      bkarow: "⤍",
      blacklozenge: "⧫",
      blacksquare: "▪",
      blacktriangle: "▴",
      blacktriangledown: "▾",
      blacktriangleleft: "◂",
      blacktriangleright: "▸",
      blank: "␣",
      blk12: "▒",
      blk14: "░",
      blk34: "▓",
      block: "█",
      bne: "=⃥",
      bnequiv: "≡⃥",
      bNot: "⫭",
      bnot: "⌐",
      Bopf: "𝔹",
      bopf: "𝕓",
      bot: "⊥",
      bottom: "⊥",
      bowtie: "⋈",
      boxbox: "⧉",
      boxDL: "╗",
      boxDl: "╖",
      boxdL: "╕",
      boxdl: "┐",
      boxDR: "╔",
      boxDr: "╓",
      boxdR: "╒",
      boxdr: "┌",
      boxH: "═",
      boxh: "─",
      boxHD: "╦",
      boxHd: "╤",
      boxhD: "╥",
      boxhd: "┬",
      boxHU: "╩",
      boxHu: "╧",
      boxhU: "╨",
      boxhu: "┴",
      boxminus: "⊟",
      boxplus: "⊞",
      boxtimes: "⊠",
      boxUL: "╝",
      boxUl: "╜",
      boxuL: "╛",
      boxul: "┘",
      boxUR: "╚",
      boxUr: "╙",
      boxuR: "╘",
      boxur: "└",
      boxV: "║",
      boxv: "│",
      boxVH: "╬",
      boxVh: "╫",
      boxvH: "╪",
      boxvh: "┼",
      boxVL: "╣",
      boxVl: "╢",
      boxvL: "╡",
      boxvl: "┤",
      boxVR: "╠",
      boxVr: "╟",
      boxvR: "╞",
      boxvr: "├",
      bprime: "‵",
      Breve: "˘",
      breve: "˘",
      brvbar: "¦",
      Bscr: "ℬ",
      bscr: "𝒷",
      bsemi: "⁏",
      bsim: "∽",
      bsime: "⋍",
      bsol: "\\",
      bsolb: "⧅",
      bsolhsub: "⟈",
      bull: "•",
      bullet: "•",
      bump: "≎",
      bumpE: "⪮",
      bumpe: "≏",
      Bumpeq: "≎",
      bumpeq: "≏",
      Cacute: "Ć",
      cacute: "ć",
      Cap: "⋒",
      cap: "∩",
      capand: "⩄",
      capbrcup: "⩉",
      capcap: "⩋",
      capcup: "⩇",
      capdot: "⩀",
      CapitalDifferentialD: "ⅅ",
      caps: "∩︀",
      caret: "⁁",
      caron: "ˇ",
      Cayleys: "ℭ",
      ccaps: "⩍",
      Ccaron: "Č",
      ccaron: "č",
      Ccedil: "Ç",
      ccedil: "ç",
      Ccirc: "Ĉ",
      ccirc: "ĉ",
      Cconint: "∰",
      ccups: "⩌",
      ccupssm: "⩐",
      Cdot: "Ċ",
      cdot: "ċ",
      cedil: "¸",
      Cedilla: "¸",
      cemptyv: "⦲",
      cent: "¢",
      CenterDot: "·",
      centerdot: "·",
      Cfr: "ℭ",
      cfr: "𝔠",
      CHcy: "Ч",
      chcy: "ч",
      check: "✓",
      checkmark: "✓",
      Chi: "Χ",
      chi: "χ",
      cir: "○",
      circ: "ˆ",
      circeq: "≗",
      circlearrowleft: "↺",
      circlearrowright: "↻",
      circledast: "⊛",
      circledcirc: "⊚",
      circleddash: "⊝",
      CircleDot: "⊙",
      circledR: "®",
      circledS: "Ⓢ",
      CircleMinus: "⊖",
      CirclePlus: "⊕",
      CircleTimes: "⊗",
      cirE: "⧃",
      cire: "≗",
      cirfnint: "⨐",
      cirmid: "⫯",
      cirscir: "⧂",
      ClockwiseContourIntegral: "∲",
      CloseCurlyDoubleQuote: "”",
      CloseCurlyQuote: "’",
      clubs: "♣",
      clubsuit: "♣",
      Colon: "∷",
      colon: ":",
      Colone: "⩴",
      colone: "≔",
      coloneq: "≔",
      comma: ",",
      commat: "@",
      comp: "∁",
      compfn: "∘",
      complement: "∁",
      complexes: "ℂ",
      cong: "≅",
      congdot: "⩭",
      Congruent: "≡",
      Conint: "∯",
      conint: "∮",
      ContourIntegral: "∮",
      Copf: "ℂ",
      copf: "𝕔",
      coprod: "∐",
      Coproduct: "∐",
      COPY: "©",
      copy: "©",
      copysr: "℗",
      CounterClockwiseContourIntegral: "∳",
      crarr: "↵",
      Cross: "⨯",
      cross: "✗",
      Cscr: "𝒞",
      cscr: "𝒸",
      csub: "⫏",
      csube: "⫑",
      csup: "⫐",
      csupe: "⫒",
      ctdot: "⋯",
      cudarrl: "⤸",
      cudarrr: "⤵",
      cuepr: "⋞",
      cuesc: "⋟",
      cularr: "↶",
      cularrp: "⤽",
      Cup: "⋓",
      cup: "∪",
      cupbrcap: "⩈",
      CupCap: "≍",
      cupcap: "⩆",
      cupcup: "⩊",
      cupdot: "⊍",
      cupor: "⩅",
      cups: "∪︀",
      curarr: "↷",
      curarrm: "⤼",
      curlyeqprec: "⋞",
      curlyeqsucc: "⋟",
      curlyvee: "⋎",
      curlywedge: "⋏",
      curren: "¤",
      curvearrowleft: "↶",
      curvearrowright: "↷",
      cuvee: "⋎",
      cuwed: "⋏",
      cwconint: "∲",
      cwint: "∱",
      cylcty: "⌭",
      Dagger: "‡",
      dagger: "†",
      daleth: "ℸ",
      Darr: "↡",
      dArr: "⇓",
      darr: "↓",
      dash: "‐",
      Dashv: "⫤",
      dashv: "⊣",
      dbkarow: "⤏",
      dblac: "˝",
      Dcaron: "Ď",
      dcaron: "ď",
      Dcy: "Д",
      dcy: "д",
      DD: "ⅅ",
      dd: "ⅆ",
      ddagger: "‡",
      ddarr: "⇊",
      DDotrahd: "⤑",
      ddotseq: "⩷",
      deg: "°",
      Del: "∇",
      Delta: "Δ",
      delta: "δ",
      demptyv: "⦱",
      dfisht: "⥿",
      Dfr: "𝔇",
      dfr: "𝔡",
      dHar: "⥥",
      dharl: "⇃",
      dharr: "⇂",
      DiacriticalAcute: "´",
      DiacriticalDot: "˙",
      DiacriticalDoubleAcute: "˝",
      DiacriticalGrave: "`",
      DiacriticalTilde: "˜",
      diam: "⋄",
      Diamond: "⋄",
      diamond: "⋄",
      diamondsuit: "♦",
      diams: "♦",
      die: "¨",
      DifferentialD: "ⅆ",
      digamma: "ϝ",
      disin: "⋲",
      div: "÷",
      divide: "÷",
      divideontimes: "⋇",
      divonx: "⋇",
      DJcy: "Ђ",
      djcy: "ђ",
      dlcorn: "⌞",
      dlcrop: "⌍",
      dollar: "$",
      Dopf: "𝔻",
      dopf: "𝕕",
      Dot: "¨",
      dot: "˙",
      DotDot: "⃜",
      doteq: "≐",
      doteqdot: "≑",
      DotEqual: "≐",
      dotminus: "∸",
      dotplus: "∔",
      dotsquare: "⊡",
      doublebarwedge: "⌆",
      DoubleContourIntegral: "∯",
      DoubleDot: "¨",
      DoubleDownArrow: "⇓",
      DoubleLeftArrow: "⇐",
      DoubleLeftRightArrow: "⇔",
      DoubleLeftTee: "⫤",
      DoubleLongLeftArrow: "⟸",
      DoubleLongLeftRightArrow: "⟺",
      DoubleLongRightArrow: "⟹",
      DoubleRightArrow: "⇒",
      DoubleRightTee: "⊨",
      DoubleUpArrow: "⇑",
      DoubleUpDownArrow: "⇕",
      DoubleVerticalBar: "∥",
      DownArrow: "↓",
      Downarrow: "⇓",
      downarrow: "↓",
      DownArrowBar: "⤓",
      DownArrowUpArrow: "⇵",
      DownBreve: "̑",
      downdownarrows: "⇊",
      downharpoonleft: "⇃",
      downharpoonright: "⇂",
      DownLeftRightVector: "⥐",
      DownLeftTeeVector: "⥞",
      DownLeftVector: "↽",
      DownLeftVectorBar: "⥖",
      DownRightTeeVector: "⥟",
      DownRightVector: "⇁",
      DownRightVectorBar: "⥗",
      DownTee: "⊤",
      DownTeeArrow: "↧",
      drbkarow: "⤐",
      drcorn: "⌟",
      drcrop: "⌌",
      Dscr: "𝒟",
      dscr: "𝒹",
      DScy: "Ѕ",
      dscy: "ѕ",
      dsol: "⧶",
      Dstrok: "Đ",
      dstrok: "đ",
      dtdot: "⋱",
      dtri: "▿",
      dtrif: "▾",
      duarr: "⇵",
      duhar: "⥯",
      dwangle: "⦦",
      DZcy: "Џ",
      dzcy: "џ",
      dzigrarr: "⟿",
      Eacute: "É",
      eacute: "é",
      easter: "⩮",
      Ecaron: "Ě",
      ecaron: "ě",
      ecir: "≖",
      Ecirc: "Ê",
      ecirc: "ê",
      ecolon: "≕",
      Ecy: "Э",
      ecy: "э",
      eDDot: "⩷",
      Edot: "Ė",
      eDot: "≑",
      edot: "ė",
      ee: "ⅇ",
      efDot: "≒",
      Efr: "𝔈",
      efr: "𝔢",
      eg: "⪚",
      Egrave: "È",
      egrave: "è",
      egs: "⪖",
      egsdot: "⪘",
      el: "⪙",
      Element: "∈",
      elinters: "⏧",
      ell: "ℓ",
      els: "⪕",
      elsdot: "⪗",
      Emacr: "Ē",
      emacr: "ē",
      empty: "∅",
      emptyset: "∅",
      EmptySmallSquare: "◻",
      emptyv: "∅",
      EmptyVerySmallSquare: "▫",
      emsp: " ",
      emsp13: " ",
      emsp14: " ",
      ENG: "Ŋ",
      eng: "ŋ",
      ensp: " ",
      Eogon: "Ę",
      eogon: "ę",
      Eopf: "𝔼",
      eopf: "𝕖",
      epar: "⋕",
      eparsl: "⧣",
      eplus: "⩱",
      epsi: "ε",
      Epsilon: "Ε",
      epsilon: "ε",
      epsiv: "ϵ",
      eqcirc: "≖",
      eqcolon: "≕",
      eqsim: "≂",
      eqslantgtr: "⪖",
      eqslantless: "⪕",
      Equal: "⩵",
      equals: "=",
      EqualTilde: "≂",
      equest: "≟",
      Equilibrium: "⇌",
      equiv: "≡",
      equivDD: "⩸",
      eqvparsl: "⧥",
      erarr: "⥱",
      erDot: "≓",
      Escr: "ℰ",
      escr: "ℯ",
      esdot: "≐",
      Esim: "⩳",
      esim: "≂",
      Eta: "Η",
      eta: "η",
      ETH: "Ð",
      eth: "ð",
      Euml: "Ë",
      euml: "ë",
      euro: "€",
      excl: "!",
      exist: "∃",
      Exists: "∃",
      expectation: "ℰ",
      ExponentialE: "ⅇ",
      exponentiale: "ⅇ",
      fallingdotseq: "≒",
      Fcy: "Ф",
      fcy: "ф",
      female: "♀",
      ffilig: "ﬃ",
      fflig: "ﬀ",
      ffllig: "ﬄ",
      Ffr: "𝔉",
      ffr: "𝔣",
      filig: "ﬁ",
      FilledSmallSquare: "◼",
      FilledVerySmallSquare: "▪",
      fjlig: "fj",
      flat: "♭",
      fllig: "ﬂ",
      fltns: "▱",
      fnof: "ƒ",
      Fopf: "𝔽",
      fopf: "𝕗",
      ForAll: "∀",
      forall: "∀",
      fork: "⋔",
      forkv: "⫙",
      Fouriertrf: "ℱ",
      fpartint: "⨍",
      frac12: "½",
      frac13: "⅓",
      frac14: "¼",
      frac15: "⅕",
      frac16: "⅙",
      frac18: "⅛",
      frac23: "⅔",
      frac25: "⅖",
      frac34: "¾",
      frac35: "⅗",
      frac38: "⅜",
      frac45: "⅘",
      frac56: "⅚",
      frac58: "⅝",
      frac78: "⅞",
      frasl: "⁄",
      frown: "⌢",
      Fscr: "ℱ",
      fscr: "𝒻",
      gacute: "ǵ",
      Gamma: "Γ",
      gamma: "γ",
      Gammad: "Ϝ",
      gammad: "ϝ",
      gap: "⪆",
      Gbreve: "Ğ",
      gbreve: "ğ",
      Gcedil: "Ģ",
      Gcirc: "Ĝ",
      gcirc: "ĝ",
      Gcy: "Г",
      gcy: "г",
      Gdot: "Ġ",
      gdot: "ġ",
      gE: "≧",
      ge: "≥",
      gEl: "⪌",
      gel: "⋛",
      geq: "≥",
      geqq: "≧",
      geqslant: "⩾",
      ges: "⩾",
      gescc: "⪩",
      gesdot: "⪀",
      gesdoto: "⪂",
      gesdotol: "⪄",
      gesl: "⋛︀",
      gesles: "⪔",
      Gfr: "𝔊",
      gfr: "𝔤",
      Gg: "⋙",
      gg: "≫",
      ggg: "⋙",
      gimel: "ℷ",
      GJcy: "Ѓ",
      gjcy: "ѓ",
      gl: "≷",
      gla: "⪥",
      glE: "⪒",
      glj: "⪤",
      gnap: "⪊",
      gnapprox: "⪊",
      gnE: "≩",
      gne: "⪈",
      gneq: "⪈",
      gneqq: "≩",
      gnsim: "⋧",
      Gopf: "𝔾",
      gopf: "𝕘",
      grave: "`",
      GreaterEqual: "≥",
      GreaterEqualLess: "⋛",
      GreaterFullEqual: "≧",
      GreaterGreater: "⪢",
      GreaterLess: "≷",
      GreaterSlantEqual: "⩾",
      GreaterTilde: "≳",
      Gscr: "𝒢",
      gscr: "ℊ",
      gsim: "≳",
      gsime: "⪎",
      gsiml: "⪐",
      Gt: "≫",
      GT: ">",
      gt: ">",
      gtcc: "⪧",
      gtcir: "⩺",
      gtdot: "⋗",
      gtlPar: "⦕",
      gtquest: "⩼",
      gtrapprox: "⪆",
      gtrarr: "⥸",
      gtrdot: "⋗",
      gtreqless: "⋛",
      gtreqqless: "⪌",
      gtrless: "≷",
      gtrsim: "≳",
      gvertneqq: "≩︀",
      gvnE: "≩︀",
      Hacek: "ˇ",
      hairsp: " ",
      half: "½",
      hamilt: "ℋ",
      HARDcy: "Ъ",
      hardcy: "ъ",
      hArr: "⇔",
      harr: "↔",
      harrcir: "⥈",
      harrw: "↭",
      Hat: "^",
      hbar: "ℏ",
      Hcirc: "Ĥ",
      hcirc: "ĥ",
      hearts: "♥",
      heartsuit: "♥",
      hellip: "…",
      hercon: "⊹",
      Hfr: "ℌ",
      hfr: "𝔥",
      HilbertSpace: "ℋ",
      hksearow: "⤥",
      hkswarow: "⤦",
      hoarr: "⇿",
      homtht: "∻",
      hookleftarrow: "↩",
      hookrightarrow: "↪",
      Hopf: "ℍ",
      hopf: "𝕙",
      horbar: "―",
      HorizontalLine: "─",
      Hscr: "ℋ",
      hscr: "𝒽",
      hslash: "ℏ",
      Hstrok: "Ħ",
      hstrok: "ħ",
      HumpDownHump: "≎",
      HumpEqual: "≏",
      hybull: "⁃",
      hyphen: "‐",
      Iacute: "Í",
      iacute: "í",
      ic: "⁣",
      Icirc: "Î",
      icirc: "î",
      Icy: "И",
      icy: "и",
      Idot: "İ",
      IEcy: "Е",
      iecy: "е",
      iexcl: "¡",
      iff: "⇔",
      Ifr: "ℑ",
      ifr: "𝔦",
      Igrave: "Ì",
      igrave: "ì",
      ii: "ⅈ",
      iiiint: "⨌",
      iiint: "∭",
      iinfin: "⧜",
      iiota: "℩",
      IJlig: "Ĳ",
      ijlig: "ĳ",
      Im: "ℑ",
      Imacr: "Ī",
      imacr: "ī",
      image: "ℑ",
      ImaginaryI: "ⅈ",
      imagline: "ℐ",
      imagpart: "ℑ",
      imath: "ı",
      imof: "⊷",
      imped: "Ƶ",
      Implies: "⇒",
      in: "∈",
      incare: "℅",
      infin: "∞",
      infintie: "⧝",
      inodot: "ı",
      Int: "∬",
      int: "∫",
      intcal: "⊺",
      integers: "ℤ",
      Integral: "∫",
      intercal: "⊺",
      Intersection: "⋂",
      intlarhk: "⨗",
      intprod: "⨼",
      InvisibleComma: "⁣",
      InvisibleTimes: "⁢",
      IOcy: "Ё",
      iocy: "ё",
      Iogon: "Į",
      iogon: "į",
      Iopf: "𝕀",
      iopf: "𝕚",
      Iota: "Ι",
      iota: "ι",
      iprod: "⨼",
      iquest: "¿",
      Iscr: "ℐ",
      iscr: "𝒾",
      isin: "∈",
      isindot: "⋵",
      isinE: "⋹",
      isins: "⋴",
      isinsv: "⋳",
      isinv: "∈",
      it: "⁢",
      Itilde: "Ĩ",
      itilde: "ĩ",
      Iukcy: "І",
      iukcy: "і",
      Iuml: "Ï",
      iuml: "ï",
      Jcirc: "Ĵ",
      jcirc: "ĵ",
      Jcy: "Й",
      jcy: "й",
      Jfr: "𝔍",
      jfr: "𝔧",
      jmath: "ȷ",
      Jopf: "𝕁",
      jopf: "𝕛",
      Jscr: "𝒥",
      jscr: "𝒿",
      Jsercy: "Ј",
      jsercy: "ј",
      Jukcy: "Є",
      jukcy: "є",
      Kappa: "Κ",
      kappa: "κ",
      kappav: "ϰ",
      Kcedil: "Ķ",
      kcedil: "ķ",
      Kcy: "К",
      kcy: "к",
      Kfr: "𝔎",
      kfr: "𝔨",
      kgreen: "ĸ",
      KHcy: "Х",
      khcy: "х",
      KJcy: "Ќ",
      kjcy: "ќ",
      Kopf: "𝕂",
      kopf: "𝕜",
      Kscr: "𝒦",
      kscr: "𝓀",
      lAarr: "⇚",
      Lacute: "Ĺ",
      lacute: "ĺ",
      laemptyv: "⦴",
      lagran: "ℒ",
      Lambda: "Λ",
      lambda: "λ",
      Lang: "⟪",
      lang: "⟨",
      langd: "⦑",
      langle: "⟨",
      lap: "⪅",
      Laplacetrf: "ℒ",
      laquo: "«",
      Larr: "↞",
      lArr: "⇐",
      larr: "←",
      larrb: "⇤",
      larrbfs: "⤟",
      larrfs: "⤝",
      larrhk: "↩",
      larrlp: "↫",
      larrpl: "⤹",
      larrsim: "⥳",
      larrtl: "↢",
      lat: "⪫",
      lAtail: "⤛",
      latail: "⤙",
      late: "⪭",
      lates: "⪭︀",
      lBarr: "⤎",
      lbarr: "⤌",
      lbbrk: "❲",
      lbrace: "{",
      lbrack: "[",
      lbrke: "⦋",
      lbrksld: "⦏",
      lbrkslu: "⦍",
      Lcaron: "Ľ",
      lcaron: "ľ",
      Lcedil: "Ļ",
      lcedil: "ļ",
      lceil: "⌈",
      lcub: "{",
      Lcy: "Л",
      lcy: "л",
      ldca: "⤶",
      ldquo: "“",
      ldquor: "„",
      ldrdhar: "⥧",
      ldrushar: "⥋",
      ldsh: "↲",
      lE: "≦",
      le: "≤",
      LeftAngleBracket: "⟨",
      LeftArrow: "←",
      Leftarrow: "⇐",
      leftarrow: "←",
      LeftArrowBar: "⇤",
      LeftArrowRightArrow: "⇆",
      leftarrowtail: "↢",
      LeftCeiling: "⌈",
      LeftDoubleBracket: "⟦",
      LeftDownTeeVector: "⥡",
      LeftDownVector: "⇃",
      LeftDownVectorBar: "⥙",
      LeftFloor: "⌊",
      leftharpoondown: "↽",
      leftharpoonup: "↼",
      leftleftarrows: "⇇",
      LeftRightArrow: "↔",
      Leftrightarrow: "⇔",
      leftrightarrow: "↔",
      leftrightarrows: "⇆",
      leftrightharpoons: "⇋",
      leftrightsquigarrow: "↭",
      LeftRightVector: "⥎",
      LeftTee: "⊣",
      LeftTeeArrow: "↤",
      LeftTeeVector: "⥚",
      leftthreetimes: "⋋",
      LeftTriangle: "⊲",
      LeftTriangleBar: "⧏",
      LeftTriangleEqual: "⊴",
      LeftUpDownVector: "⥑",
      LeftUpTeeVector: "⥠",
      LeftUpVector: "↿",
      LeftUpVectorBar: "⥘",
      LeftVector: "↼",
      LeftVectorBar: "⥒",
      lEg: "⪋",
      leg: "⋚",
      leq: "≤",
      leqq: "≦",
      leqslant: "⩽",
      les: "⩽",
      lescc: "⪨",
      lesdot: "⩿",
      lesdoto: "⪁",
      lesdotor: "⪃",
      lesg: "⋚︀",
      lesges: "⪓",
      lessapprox: "⪅",
      lessdot: "⋖",
      lesseqgtr: "⋚",
      lesseqqgtr: "⪋",
      LessEqualGreater: "⋚",
      LessFullEqual: "≦",
      LessGreater: "≶",
      lessgtr: "≶",
      LessLess: "⪡",
      lesssim: "≲",
      LessSlantEqual: "⩽",
      LessTilde: "≲",
      lfisht: "⥼",
      lfloor: "⌊",
      Lfr: "𝔏",
      lfr: "𝔩",
      lg: "≶",
      lgE: "⪑",
      lHar: "⥢",
      lhard: "↽",
      lharu: "↼",
      lharul: "⥪",
      lhblk: "▄",
      LJcy: "Љ",
      ljcy: "љ",
      Ll: "⋘",
      ll: "≪",
      llarr: "⇇",
      llcorner: "⌞",
      Lleftarrow: "⇚",
      llhard: "⥫",
      lltri: "◺",
      Lmidot: "Ŀ",
      lmidot: "ŀ",
      lmoust: "⎰",
      lmoustache: "⎰",
      lnap: "⪉",
      lnapprox: "⪉",
      lnE: "≨",
      lne: "⪇",
      lneq: "⪇",
      lneqq: "≨",
      lnsim: "⋦",
      loang: "⟬",
      loarr: "⇽",
      lobrk: "⟦",
      LongLeftArrow: "⟵",
      Longleftarrow: "⟸",
      longleftarrow: "⟵",
      LongLeftRightArrow: "⟷",
      Longleftrightarrow: "⟺",
      longleftrightarrow: "⟷",
      longmapsto: "⟼",
      LongRightArrow: "⟶",
      Longrightarrow: "⟹",
      longrightarrow: "⟶",
      looparrowleft: "↫",
      looparrowright: "↬",
      lopar: "⦅",
      Lopf: "𝕃",
      lopf: "𝕝",
      loplus: "⨭",
      lotimes: "⨴",
      lowast: "∗",
      lowbar: "_",
      LowerLeftArrow: "↙",
      LowerRightArrow: "↘",
      loz: "◊",
      lozenge: "◊",
      lozf: "⧫",
      lpar: "(",
      lparlt: "⦓",
      lrarr: "⇆",
      lrcorner: "⌟",
      lrhar: "⇋",
      lrhard: "⥭",
      lrm: "‎",
      lrtri: "⊿",
      lsaquo: "‹",
      Lscr: "ℒ",
      lscr: "𝓁",
      Lsh: "↰",
      lsh: "↰",
      lsim: "≲",
      lsime: "⪍",
      lsimg: "⪏",
      lsqb: "[",
      lsquo: "‘",
      lsquor: "‚",
      Lstrok: "Ł",
      lstrok: "ł",
      Lt: "≪",
      LT: "<",
      lt: "<",
      ltcc: "⪦",
      ltcir: "⩹",
      ltdot: "⋖",
      lthree: "⋋",
      ltimes: "⋉",
      ltlarr: "⥶",
      ltquest: "⩻",
      ltri: "◃",
      ltrie: "⊴",
      ltrif: "◂",
      ltrPar: "⦖",
      lurdshar: "⥊",
      luruhar: "⥦",
      lvertneqq: "≨︀",
      lvnE: "≨︀",
      macr: "¯",
      male: "♂",
      malt: "✠",
      maltese: "✠",
      Map: "⤅",
      map: "↦",
      mapsto: "↦",
      mapstodown: "↧",
      mapstoleft: "↤",
      mapstoup: "↥",
      marker: "▮",
      mcomma: "⨩",
      Mcy: "М",
      mcy: "м",
      mdash: "—",
      mDDot: "∺",
      measuredangle: "∡",
      MediumSpace: " ",
      Mellintrf: "ℳ",
      Mfr: "𝔐",
      mfr: "𝔪",
      mho: "℧",
      micro: "µ",
      mid: "∣",
      midast: "*",
      midcir: "⫰",
      middot: "·",
      minus: "−",
      minusb: "⊟",
      minusd: "∸",
      minusdu: "⨪",
      MinusPlus: "∓",
      mlcp: "⫛",
      mldr: "…",
      mnplus: "∓",
      models: "⊧",
      Mopf: "𝕄",
      mopf: "𝕞",
      mp: "∓",
      Mscr: "ℳ",
      mscr: "𝓂",
      mstpos: "∾",
      Mu: "Μ",
      mu: "μ",
      multimap: "⊸",
      mumap: "⊸",
      nabla: "∇",
      Nacute: "Ń",
      nacute: "ń",
      nang: "∠⃒",
      nap: "≉",
      napE: "⩰̸",
      napid: "≋̸",
      napos: "ŉ",
      napprox: "≉",
      natur: "♮",
      natural: "♮",
      naturals: "ℕ",
      nbsp: " ",
      nbump: "≎̸",
      nbumpe: "≏̸",
      ncap: "⩃",
      Ncaron: "Ň",
      ncaron: "ň",
      Ncedil: "Ņ",
      ncedil: "ņ",
      ncong: "≇",
      ncongdot: "⩭̸",
      ncup: "⩂",
      Ncy: "Н",
      ncy: "н",
      ndash: "–",
      ne: "≠",
      nearhk: "⤤",
      neArr: "⇗",
      nearr: "↗",
      nearrow: "↗",
      nedot: "≐̸",
      NegativeMediumSpace: "​",
      NegativeThickSpace: "​",
      NegativeThinSpace: "​",
      NegativeVeryThinSpace: "​",
      nequiv: "≢",
      nesear: "⤨",
      nesim: "≂̸",
      NestedGreaterGreater: "≫",
      NestedLessLess: "≪",
      NewLine: "\n",
      nexist: "∄",
      nexists: "∄",
      Nfr: "𝔑",
      nfr: "𝔫",
      ngE: "≧̸",
      nge: "≱",
      ngeq: "≱",
      ngeqq: "≧̸",
      ngeqslant: "⩾̸",
      nges: "⩾̸",
      nGg: "⋙̸",
      ngsim: "≵",
      nGt: "≫⃒",
      ngt: "≯",
      ngtr: "≯",
      nGtv: "≫̸",
      nhArr: "⇎",
      nharr: "↮",
      nhpar: "⫲",
      ni: "∋",
      nis: "⋼",
      nisd: "⋺",
      niv: "∋",
      NJcy: "Њ",
      njcy: "њ",
      nlArr: "⇍",
      nlarr: "↚",
      nldr: "‥",
      nlE: "≦̸",
      nle: "≰",
      nLeftarrow: "⇍",
      nleftarrow: "↚",
      nLeftrightarrow: "⇎",
      nleftrightarrow: "↮",
      nleq: "≰",
      nleqq: "≦̸",
      nleqslant: "⩽̸",
      nles: "⩽̸",
      nless: "≮",
      nLl: "⋘̸",
      nlsim: "≴",
      nLt: "≪⃒",
      nlt: "≮",
      nltri: "⋪",
      nltrie: "⋬",
      nLtv: "≪̸",
      nmid: "∤",
      NoBreak: "⁠",
      NonBreakingSpace: " ",
      Nopf: "ℕ",
      nopf: "𝕟",
      Not: "⫬",
      not: "¬",
      NotCongruent: "≢",
      NotCupCap: "≭",
      NotDoubleVerticalBar: "∦",
      NotElement: "∉",
      NotEqual: "≠",
      NotEqualTilde: "≂̸",
      NotExists: "∄",
      NotGreater: "≯",
      NotGreaterEqual: "≱",
      NotGreaterFullEqual: "≧̸",
      NotGreaterGreater: "≫̸",
      NotGreaterLess: "≹",
      NotGreaterSlantEqual: "⩾̸",
      NotGreaterTilde: "≵",
      NotHumpDownHump: "≎̸",
      NotHumpEqual: "≏̸",
      notin: "∉",
      notindot: "⋵̸",
      notinE: "⋹̸",
      notinva: "∉",
      notinvb: "⋷",
      notinvc: "⋶",
      NotLeftTriangle: "⋪",
      NotLeftTriangleBar: "⧏̸",
      NotLeftTriangleEqual: "⋬",
      NotLess: "≮",
      NotLessEqual: "≰",
      NotLessGreater: "≸",
      NotLessLess: "≪̸",
      NotLessSlantEqual: "⩽̸",
      NotLessTilde: "≴",
      NotNestedGreaterGreater: "⪢̸",
      NotNestedLessLess: "⪡̸",
      notni: "∌",
      notniva: "∌",
      notnivb: "⋾",
      notnivc: "⋽",
      NotPrecedes: "⊀",
      NotPrecedesEqual: "⪯̸",
      NotPrecedesSlantEqual: "⋠",
      NotReverseElement: "∌",
      NotRightTriangle: "⋫",
      NotRightTriangleBar: "⧐̸",
      NotRightTriangleEqual: "⋭",
      NotSquareSubset: "⊏̸",
      NotSquareSubsetEqual: "⋢",
      NotSquareSuperset: "⊐̸",
      NotSquareSupersetEqual: "⋣",
      NotSubset: "⊂⃒",
      NotSubsetEqual: "⊈",
      NotSucceeds: "⊁",
      NotSucceedsEqual: "⪰̸",
      NotSucceedsSlantEqual: "⋡",
      NotSucceedsTilde: "≿̸",
      NotSuperset: "⊃⃒",
      NotSupersetEqual: "⊉",
      NotTilde: "≁",
      NotTildeEqual: "≄",
      NotTildeFullEqual: "≇",
      NotTildeTilde: "≉",
      NotVerticalBar: "∤",
      npar: "∦",
      nparallel: "∦",
      nparsl: "⫽⃥",
      npart: "∂̸",
      npolint: "⨔",
      npr: "⊀",
      nprcue: "⋠",
      npre: "⪯̸",
      nprec: "⊀",
      npreceq: "⪯̸",
      nrArr: "⇏",
      nrarr: "↛",
      nrarrc: "⤳̸",
      nrarrw: "↝̸",
      nRightarrow: "⇏",
      nrightarrow: "↛",
      nrtri: "⋫",
      nrtrie: "⋭",
      nsc: "⊁",
      nsccue: "⋡",
      nsce: "⪰̸",
      Nscr: "𝒩",
      nscr: "𝓃",
      nshortmid: "∤",
      nshortparallel: "∦",
      nsim: "≁",
      nsime: "≄",
      nsimeq: "≄",
      nsmid: "∤",
      nspar: "∦",
      nsqsube: "⋢",
      nsqsupe: "⋣",
      nsub: "⊄",
      nsubE: "⫅̸",
      nsube: "⊈",
      nsubset: "⊂⃒",
      nsubseteq: "⊈",
      nsubseteqq: "⫅̸",
      nsucc: "⊁",
      nsucceq: "⪰̸",
      nsup: "⊅",
      nsupE: "⫆̸",
      nsupe: "⊉",
      nsupset: "⊃⃒",
      nsupseteq: "⊉",
      nsupseteqq: "⫆̸",
      ntgl: "≹",
      Ntilde: "Ñ",
      ntilde: "ñ",
      ntlg: "≸",
      ntriangleleft: "⋪",
      ntrianglelefteq: "⋬",
      ntriangleright: "⋫",
      ntrianglerighteq: "⋭",
      Nu: "Ν",
      nu: "ν",
      num: "#",
      numero: "№",
      numsp: " ",
      nvap: "≍⃒",
      nVDash: "⊯",
      nVdash: "⊮",
      nvDash: "⊭",
      nvdash: "⊬",
      nvge: "≥⃒",
      nvgt: ">⃒",
      nvHarr: "⤄",
      nvinfin: "⧞",
      nvlArr: "⤂",
      nvle: "≤⃒",
      nvlt: "<⃒",
      nvltrie: "⊴⃒",
      nvrArr: "⤃",
      nvrtrie: "⊵⃒",
      nvsim: "∼⃒",
      nwarhk: "⤣",
      nwArr: "⇖",
      nwarr: "↖",
      nwarrow: "↖",
      nwnear: "⤧",
      Oacute: "Ó",
      oacute: "ó",
      oast: "⊛",
      ocir: "⊚",
      Ocirc: "Ô",
      ocirc: "ô",
      Ocy: "О",
      ocy: "о",
      odash: "⊝",
      Odblac: "Ő",
      odblac: "ő",
      odiv: "⨸",
      odot: "⊙",
      odsold: "⦼",
      OElig: "Œ",
      oelig: "œ",
      ofcir: "⦿",
      Ofr: "𝔒",
      ofr: "𝔬",
      ogon: "˛",
      Ograve: "Ò",
      ograve: "ò",
      ogt: "⧁",
      ohbar: "⦵",
      ohm: "Ω",
      oint: "∮",
      olarr: "↺",
      olcir: "⦾",
      olcross: "⦻",
      oline: "‾",
      olt: "⧀",
      Omacr: "Ō",
      omacr: "ō",
      Omega: "Ω",
      omega: "ω",
      Omicron: "Ο",
      omicron: "ο",
      omid: "⦶",
      ominus: "⊖",
      Oopf: "𝕆",
      oopf: "𝕠",
      opar: "⦷",
      OpenCurlyDoubleQuote: "“",
      OpenCurlyQuote: "‘",
      operp: "⦹",
      oplus: "⊕",
      Or: "⩔",
      or: "∨",
      orarr: "↻",
      ord: "⩝",
      order: "ℴ",
      orderof: "ℴ",
      ordf: "ª",
      ordm: "º",
      origof: "⊶",
      oror: "⩖",
      orslope: "⩗",
      orv: "⩛",
      oS: "Ⓢ",
      Oscr: "𝒪",
      oscr: "ℴ",
      Oslash: "Ø",
      oslash: "ø",
      osol: "⊘",
      Otilde: "Õ",
      otilde: "õ",
      Otimes: "⨷",
      otimes: "⊗",
      otimesas: "⨶",
      Ouml: "Ö",
      ouml: "ö",
      ovbar: "⌽",
      OverBar: "‾",
      OverBrace: "⏞",
      OverBracket: "⎴",
      OverParenthesis: "⏜",
      par: "∥",
      para: "¶",
      parallel: "∥",
      parsim: "⫳",
      parsl: "⫽",
      part: "∂",
      PartialD: "∂",
      Pcy: "П",
      pcy: "п",
      percnt: "%",
      period: ".",
      permil: "‰",
      perp: "⊥",
      pertenk: "‱",
      Pfr: "𝔓",
      pfr: "𝔭",
      Phi: "Φ",
      phi: "φ",
      phiv: "ϕ",
      phmmat: "ℳ",
      phone: "☎",
      Pi: "Π",
      pi: "π",
      pitchfork: "⋔",
      piv: "ϖ",
      planck: "ℏ",
      planckh: "ℎ",
      plankv: "ℏ",
      plus: "+",
      plusacir: "⨣",
      plusb: "⊞",
      pluscir: "⨢",
      plusdo: "∔",
      plusdu: "⨥",
      pluse: "⩲",
      PlusMinus: "±",
      plusmn: "±",
      plussim: "⨦",
      plustwo: "⨧",
      pm: "±",
      Poincareplane: "ℌ",
      pointint: "⨕",
      Popf: "ℙ",
      popf: "𝕡",
      pound: "£",
      Pr: "⪻",
      pr: "≺",
      prap: "⪷",
      prcue: "≼",
      prE: "⪳",
      pre: "⪯",
      prec: "≺",
      precapprox: "⪷",
      preccurlyeq: "≼",
      Precedes: "≺",
      PrecedesEqual: "⪯",
      PrecedesSlantEqual: "≼",
      PrecedesTilde: "≾",
      preceq: "⪯",
      precnapprox: "⪹",
      precneqq: "⪵",
      precnsim: "⋨",
      precsim: "≾",
      Prime: "″",
      prime: "′",
      primes: "ℙ",
      prnap: "⪹",
      prnE: "⪵",
      prnsim: "⋨",
      prod: "∏",
      Product: "∏",
      profalar: "⌮",
      profline: "⌒",
      profsurf: "⌓",
      prop: "∝",
      Proportion: "∷",
      Proportional: "∝",
      propto: "∝",
      prsim: "≾",
      prurel: "⊰",
      Pscr: "𝒫",
      pscr: "𝓅",
      Psi: "Ψ",
      psi: "ψ",
      puncsp: " ",
      Qfr: "𝔔",
      qfr: "𝔮",
      qint: "⨌",
      Qopf: "ℚ",
      qopf: "𝕢",
      qprime: "⁗",
      Qscr: "𝒬",
      qscr: "𝓆",
      quaternions: "ℍ",
      quatint: "⨖",
      quest: "?",
      questeq: "≟",
      QUOT: '"',
      quot: '"',
      rAarr: "⇛",
      race: "∽̱",
      Racute: "Ŕ",
      racute: "ŕ",
      radic: "√",
      raemptyv: "⦳",
      Rang: "⟫",
      rang: "⟩",
      rangd: "⦒",
      range: "⦥",
      rangle: "⟩",
      raquo: "»",
      Rarr: "↠",
      rArr: "⇒",
      rarr: "→",
      rarrap: "⥵",
      rarrb: "⇥",
      rarrbfs: "⤠",
      rarrc: "⤳",
      rarrfs: "⤞",
      rarrhk: "↪",
      rarrlp: "↬",
      rarrpl: "⥅",
      rarrsim: "⥴",
      Rarrtl: "⤖",
      rarrtl: "↣",
      rarrw: "↝",
      rAtail: "⤜",
      ratail: "⤚",
      ratio: "∶",
      rationals: "ℚ",
      RBarr: "⤐",
      rBarr: "⤏",
      rbarr: "⤍",
      rbbrk: "❳",
      rbrace: "}",
      rbrack: "]",
      rbrke: "⦌",
      rbrksld: "⦎",
      rbrkslu: "⦐",
      Rcaron: "Ř",
      rcaron: "ř",
      Rcedil: "Ŗ",
      rcedil: "ŗ",
      rceil: "⌉",
      rcub: "}",
      Rcy: "Р",
      rcy: "р",
      rdca: "⤷",
      rdldhar: "⥩",
      rdquo: "”",
      rdquor: "”",
      rdsh: "↳",
      Re: "ℜ",
      real: "ℜ",
      realine: "ℛ",
      realpart: "ℜ",
      reals: "ℝ",
      rect: "▭",
      REG: "®",
      reg: "®",
      ReverseElement: "∋",
      ReverseEquilibrium: "⇋",
      ReverseUpEquilibrium: "⥯",
      rfisht: "⥽",
      rfloor: "⌋",
      Rfr: "ℜ",
      rfr: "𝔯",
      rHar: "⥤",
      rhard: "⇁",
      rharu: "⇀",
      rharul: "⥬",
      Rho: "Ρ",
      rho: "ρ",
      rhov: "ϱ",
      RightAngleBracket: "⟩",
      RightArrow: "→",
      Rightarrow: "⇒",
      rightarrow: "→",
      RightArrowBar: "⇥",
      RightArrowLeftArrow: "⇄",
      rightarrowtail: "↣",
      RightCeiling: "⌉",
      RightDoubleBracket: "⟧",
      RightDownTeeVector: "⥝",
      RightDownVector: "⇂",
      RightDownVectorBar: "⥕",
      RightFloor: "⌋",
      rightharpoondown: "⇁",
      rightharpoonup: "⇀",
      rightleftarrows: "⇄",
      rightleftharpoons: "⇌",
      rightrightarrows: "⇉",
      rightsquigarrow: "↝",
      RightTee: "⊢",
      RightTeeArrow: "↦",
      RightTeeVector: "⥛",
      rightthreetimes: "⋌",
      RightTriangle: "⊳",
      RightTriangleBar: "⧐",
      RightTriangleEqual: "⊵",
      RightUpDownVector: "⥏",
      RightUpTeeVector: "⥜",
      RightUpVector: "↾",
      RightUpVectorBar: "⥔",
      RightVector: "⇀",
      RightVectorBar: "⥓",
      ring: "˚",
      risingdotseq: "≓",
      rlarr: "⇄",
      rlhar: "⇌",
      rlm: "‏",
      rmoust: "⎱",
      rmoustache: "⎱",
      rnmid: "⫮",
      roang: "⟭",
      roarr: "⇾",
      robrk: "⟧",
      ropar: "⦆",
      Ropf: "ℝ",
      ropf: "𝕣",
      roplus: "⨮",
      rotimes: "⨵",
      RoundImplies: "⥰",
      rpar: ")",
      rpargt: "⦔",
      rppolint: "⨒",
      rrarr: "⇉",
      Rrightarrow: "⇛",
      rsaquo: "›",
      Rscr: "ℛ",
      rscr: "𝓇",
      Rsh: "↱",
      rsh: "↱",
      rsqb: "]",
      rsquo: "’",
      rsquor: "’",
      rthree: "⋌",
      rtimes: "⋊",
      rtri: "▹",
      rtrie: "⊵",
      rtrif: "▸",
      rtriltri: "⧎",
      RuleDelayed: "⧴",
      ruluhar: "⥨",
      rx: "℞",
      Sacute: "Ś",
      sacute: "ś",
      sbquo: "‚",
      Sc: "⪼",
      sc: "≻",
      scap: "⪸",
      Scaron: "Š",
      scaron: "š",
      sccue: "≽",
      scE: "⪴",
      sce: "⪰",
      Scedil: "Ş",
      scedil: "ş",
      Scirc: "Ŝ",
      scirc: "ŝ",
      scnap: "⪺",
      scnE: "⪶",
      scnsim: "⋩",
      scpolint: "⨓",
      scsim: "≿",
      Scy: "С",
      scy: "с",
      sdot: "⋅",
      sdotb: "⊡",
      sdote: "⩦",
      searhk: "⤥",
      seArr: "⇘",
      searr: "↘",
      searrow: "↘",
      sect: "§",
      semi: ";",
      seswar: "⤩",
      setminus: "∖",
      setmn: "∖",
      sext: "✶",
      Sfr: "𝔖",
      sfr: "𝔰",
      sfrown: "⌢",
      sharp: "♯",
      SHCHcy: "Щ",
      shchcy: "щ",
      SHcy: "Ш",
      shcy: "ш",
      ShortDownArrow: "↓",
      ShortLeftArrow: "←",
      shortmid: "∣",
      shortparallel: "∥",
      ShortRightArrow: "→",
      ShortUpArrow: "↑",
      shy: "­",
      Sigma: "Σ",
      sigma: "σ",
      sigmaf: "ς",
      sigmav: "ς",
      sim: "∼",
      simdot: "⩪",
      sime: "≃",
      simeq: "≃",
      simg: "⪞",
      simgE: "⪠",
      siml: "⪝",
      simlE: "⪟",
      simne: "≆",
      simplus: "⨤",
      simrarr: "⥲",
      slarr: "←",
      SmallCircle: "∘",
      smallsetminus: "∖",
      smashp: "⨳",
      smeparsl: "⧤",
      smid: "∣",
      smile: "⌣",
      smt: "⪪",
      smte: "⪬",
      smtes: "⪬︀",
      SOFTcy: "Ь",
      softcy: "ь",
      sol: "/",
      solb: "⧄",
      solbar: "⌿",
      Sopf: "𝕊",
      sopf: "𝕤",
      spades: "♠",
      spadesuit: "♠",
      spar: "∥",
      sqcap: "⊓",
      sqcaps: "⊓︀",
      sqcup: "⊔",
      sqcups: "⊔︀",
      Sqrt: "√",
      sqsub: "⊏",
      sqsube: "⊑",
      sqsubset: "⊏",
      sqsubseteq: "⊑",
      sqsup: "⊐",
      sqsupe: "⊒",
      sqsupset: "⊐",
      sqsupseteq: "⊒",
      squ: "□",
      Square: "□",
      square: "□",
      SquareIntersection: "⊓",
      SquareSubset: "⊏",
      SquareSubsetEqual: "⊑",
      SquareSuperset: "⊐",
      SquareSupersetEqual: "⊒",
      SquareUnion: "⊔",
      squarf: "▪",
      squf: "▪",
      srarr: "→",
      Sscr: "𝒮",
      sscr: "𝓈",
      ssetmn: "∖",
      ssmile: "⌣",
      sstarf: "⋆",
      Star: "⋆",
      star: "☆",
      starf: "★",
      straightepsilon: "ϵ",
      straightphi: "ϕ",
      strns: "¯",
      Sub: "⋐",
      sub: "⊂",
      subdot: "⪽",
      subE: "⫅",
      sube: "⊆",
      subedot: "⫃",
      submult: "⫁",
      subnE: "⫋",
      subne: "⊊",
      subplus: "⪿",
      subrarr: "⥹",
      Subset: "⋐",
      subset: "⊂",
      subseteq: "⊆",
      subseteqq: "⫅",
      SubsetEqual: "⊆",
      subsetneq: "⊊",
      subsetneqq: "⫋",
      subsim: "⫇",
      subsub: "⫕",
      subsup: "⫓",
      succ: "≻",
      succapprox: "⪸",
      succcurlyeq: "≽",
      Succeeds: "≻",
      SucceedsEqual: "⪰",
      SucceedsSlantEqual: "≽",
      SucceedsTilde: "≿",
      succeq: "⪰",
      succnapprox: "⪺",
      succneqq: "⪶",
      succnsim: "⋩",
      succsim: "≿",
      SuchThat: "∋",
      Sum: "∑",
      sum: "∑",
      sung: "♪",
      Sup: "⋑",
      sup: "⊃",
      sup1: "¹",
      sup2: "²",
      sup3: "³",
      supdot: "⪾",
      supdsub: "⫘",
      supE: "⫆",
      supe: "⊇",
      supedot: "⫄",
      Superset: "⊃",
      SupersetEqual: "⊇",
      suphsol: "⟉",
      suphsub: "⫗",
      suplarr: "⥻",
      supmult: "⫂",
      supnE: "⫌",
      supne: "⊋",
      supplus: "⫀",
      Supset: "⋑",
      supset: "⊃",
      supseteq: "⊇",
      supseteqq: "⫆",
      supsetneq: "⊋",
      supsetneqq: "⫌",
      supsim: "⫈",
      supsub: "⫔",
      supsup: "⫖",
      swarhk: "⤦",
      swArr: "⇙",
      swarr: "↙",
      swarrow: "↙",
      swnwar: "⤪",
      szlig: "ß",
      Tab: "	",
      target: "⌖",
      Tau: "Τ",
      tau: "τ",
      tbrk: "⎴",
      Tcaron: "Ť",
      tcaron: "ť",
      Tcedil: "Ţ",
      tcedil: "ţ",
      Tcy: "Т",
      tcy: "т",
      tdot: "⃛",
      telrec: "⌕",
      Tfr: "𝔗",
      tfr: "𝔱",
      there4: "∴",
      Therefore: "∴",
      therefore: "∴",
      Theta: "Θ",
      theta: "θ",
      thetasym: "ϑ",
      thetav: "ϑ",
      thickapprox: "≈",
      thicksim: "∼",
      ThickSpace: "  ",
      thinsp: " ",
      ThinSpace: " ",
      thkap: "≈",
      thksim: "∼",
      THORN: "Þ",
      thorn: "þ",
      Tilde: "∼",
      tilde: "˜",
      TildeEqual: "≃",
      TildeFullEqual: "≅",
      TildeTilde: "≈",
      times: "×",
      timesb: "⊠",
      timesbar: "⨱",
      timesd: "⨰",
      tint: "∭",
      toea: "⤨",
      top: "⊤",
      topbot: "⌶",
      topcir: "⫱",
      Topf: "𝕋",
      topf: "𝕥",
      topfork: "⫚",
      tosa: "⤩",
      tprime: "‴",
      TRADE: "™",
      trade: "™",
      triangle: "▵",
      triangledown: "▿",
      triangleleft: "◃",
      trianglelefteq: "⊴",
      triangleq: "≜",
      triangleright: "▹",
      trianglerighteq: "⊵",
      tridot: "◬",
      trie: "≜",
      triminus: "⨺",
      TripleDot: "⃛",
      triplus: "⨹",
      trisb: "⧍",
      tritime: "⨻",
      trpezium: "⏢",
      Tscr: "𝒯",
      tscr: "𝓉",
      TScy: "Ц",
      tscy: "ц",
      TSHcy: "Ћ",
      tshcy: "ћ",
      Tstrok: "Ŧ",
      tstrok: "ŧ",
      twixt: "≬",
      twoheadleftarrow: "↞",
      twoheadrightarrow: "↠",
      Uacute: "Ú",
      uacute: "ú",
      Uarr: "↟",
      uArr: "⇑",
      uarr: "↑",
      Uarrocir: "⥉",
      Ubrcy: "Ў",
      ubrcy: "ў",
      Ubreve: "Ŭ",
      ubreve: "ŭ",
      Ucirc: "Û",
      ucirc: "û",
      Ucy: "У",
      ucy: "у",
      udarr: "⇅",
      Udblac: "Ű",
      udblac: "ű",
      udhar: "⥮",
      ufisht: "⥾",
      Ufr: "𝔘",
      ufr: "𝔲",
      Ugrave: "Ù",
      ugrave: "ù",
      uHar: "⥣",
      uharl: "↿",
      uharr: "↾",
      uhblk: "▀",
      ulcorn: "⌜",
      ulcorner: "⌜",
      ulcrop: "⌏",
      ultri: "◸",
      Umacr: "Ū",
      umacr: "ū",
      uml: "¨",
      UnderBar: "_",
      UnderBrace: "⏟",
      UnderBracket: "⎵",
      UnderParenthesis: "⏝",
      Union: "⋃",
      UnionPlus: "⊎",
      Uogon: "Ų",
      uogon: "ų",
      Uopf: "𝕌",
      uopf: "𝕦",
      UpArrow: "↑",
      Uparrow: "⇑",
      uparrow: "↑",
      UpArrowBar: "⤒",
      UpArrowDownArrow: "⇅",
      UpDownArrow: "↕",
      Updownarrow: "⇕",
      updownarrow: "↕",
      UpEquilibrium: "⥮",
      upharpoonleft: "↿",
      upharpoonright: "↾",
      uplus: "⊎",
      UpperLeftArrow: "↖",
      UpperRightArrow: "↗",
      Upsi: "ϒ",
      upsi: "υ",
      upsih: "ϒ",
      Upsilon: "Υ",
      upsilon: "υ",
      UpTee: "⊥",
      UpTeeArrow: "↥",
      upuparrows: "⇈",
      urcorn: "⌝",
      urcorner: "⌝",
      urcrop: "⌎",
      Uring: "Ů",
      uring: "ů",
      urtri: "◹",
      Uscr: "𝒰",
      uscr: "𝓊",
      utdot: "⋰",
      Utilde: "Ũ",
      utilde: "ũ",
      utri: "▵",
      utrif: "▴",
      uuarr: "⇈",
      Uuml: "Ü",
      uuml: "ü",
      uwangle: "⦧",
      vangrt: "⦜",
      varepsilon: "ϵ",
      varkappa: "ϰ",
      varnothing: "∅",
      varphi: "ϕ",
      varpi: "ϖ",
      varpropto: "∝",
      vArr: "⇕",
      varr: "↕",
      varrho: "ϱ",
      varsigma: "ς",
      varsubsetneq: "⊊︀",
      varsubsetneqq: "⫋︀",
      varsupsetneq: "⊋︀",
      varsupsetneqq: "⫌︀",
      vartheta: "ϑ",
      vartriangleleft: "⊲",
      vartriangleright: "⊳",
      Vbar: "⫫",
      vBar: "⫨",
      vBarv: "⫩",
      Vcy: "В",
      vcy: "в",
      VDash: "⊫",
      Vdash: "⊩",
      vDash: "⊨",
      vdash: "⊢",
      Vdashl: "⫦",
      Vee: "⋁",
      vee: "∨",
      veebar: "⊻",
      veeeq: "≚",
      vellip: "⋮",
      Verbar: "‖",
      verbar: "|",
      Vert: "‖",
      vert: "|",
      VerticalBar: "∣",
      VerticalLine: "|",
      VerticalSeparator: "❘",
      VerticalTilde: "≀",
      VeryThinSpace: " ",
      Vfr: "𝔙",
      vfr: "𝔳",
      vltri: "⊲",
      vnsub: "⊂⃒",
      vnsup: "⊃⃒",
      Vopf: "𝕍",
      vopf: "𝕧",
      vprop: "∝",
      vrtri: "⊳",
      Vscr: "𝒱",
      vscr: "𝓋",
      vsubnE: "⫋︀",
      vsubne: "⊊︀",
      vsupnE: "⫌︀",
      vsupne: "⊋︀",
      Vvdash: "⊪",
      vzigzag: "⦚",
      Wcirc: "Ŵ",
      wcirc: "ŵ",
      wedbar: "⩟",
      Wedge: "⋀",
      wedge: "∧",
      wedgeq: "≙",
      weierp: "℘",
      Wfr: "𝔚",
      wfr: "𝔴",
      Wopf: "𝕎",
      wopf: "𝕨",
      wp: "℘",
      wr: "≀",
      wreath: "≀",
      Wscr: "𝒲",
      wscr: "𝓌",
      xcap: "⋂",
      xcirc: "◯",
      xcup: "⋃",
      xdtri: "▽",
      Xfr: "𝔛",
      xfr: "𝔵",
      xhArr: "⟺",
      xharr: "⟷",
      Xi: "Ξ",
      xi: "ξ",
      xlArr: "⟸",
      xlarr: "⟵",
      xmap: "⟼",
      xnis: "⋻",
      xodot: "⨀",
      Xopf: "𝕏",
      xopf: "𝕩",
      xoplus: "⨁",
      xotime: "⨂",
      xrArr: "⟹",
      xrarr: "⟶",
      Xscr: "𝒳",
      xscr: "𝓍",
      xsqcup: "⨆",
      xuplus: "⨄",
      xutri: "△",
      xvee: "⋁",
      xwedge: "⋀",
      Yacute: "Ý",
      yacute: "ý",
      YAcy: "Я",
      yacy: "я",
      Ycirc: "Ŷ",
      ycirc: "ŷ",
      Ycy: "Ы",
      ycy: "ы",
      yen: "¥",
      Yfr: "𝔜",
      yfr: "𝔶",
      YIcy: "Ї",
      yicy: "ї",
      Yopf: "𝕐",
      yopf: "𝕪",
      Yscr: "𝒴",
      yscr: "𝓎",
      YUcy: "Ю",
      yucy: "ю",
      Yuml: "Ÿ",
      yuml: "ÿ",
      Zacute: "Ź",
      zacute: "ź",
      Zcaron: "Ž",
      zcaron: "ž",
      Zcy: "З",
      zcy: "з",
      Zdot: "Ż",
      zdot: "ż",
      zeetrf: "ℨ",
      ZeroWidthSpace: "​",
      Zeta: "Ζ",
      zeta: "ζ",
      Zfr: "ℨ",
      zfr: "𝔷",
      ZHcy: "Ж",
      zhcy: "ж",
      zigrarr: "⇝",
      Zopf: "ℤ",
      zopf: "𝕫",
      Zscr: "𝒵",
      zscr: "𝓏",
      zwj: "‍",
      zwnj: "‌"
    });
    exports.entityMap = exports.HTML_ENTITIES;
  }
});

// node_modules/@xmldom/xmldom/lib/sax.js
var require_sax = __commonJS({
  "node_modules/@xmldom/xmldom/lib/sax.js"(exports) {
    "use strict";
    var conventions = require_conventions();
    var g = require_grammar();
    var errors = require_errors();
    var isHTMLEscapableRawTextElement = conventions.isHTMLEscapableRawTextElement;
    var isHTMLMimeType = conventions.isHTMLMimeType;
    var isHTMLRawTextElement = conventions.isHTMLRawTextElement;
    var hasOwn = conventions.hasOwn;
    var NAMESPACE = conventions.NAMESPACE;
    var ParseError = errors.ParseError;
    var DOMException = errors.DOMException;
    var S_TAG = 0;
    var S_ATTR = 1;
    var S_ATTR_SPACE = 2;
    var S_EQ = 3;
    var S_ATTR_NOQUOT_VALUE = 4;
    var S_ATTR_END = 5;
    var S_TAG_SPACE = 6;
    var S_TAG_CLOSE = 7;
    function XMLReader() {
    }
    XMLReader.prototype = {
      parse: function(source, defaultNSMap, entityMap) {
        var domBuilder = this.domBuilder;
        domBuilder.startDocument();
        _copy(defaultNSMap, defaultNSMap = /* @__PURE__ */ Object.create(null));
        parse(source, defaultNSMap, entityMap, domBuilder, this.errorHandler);
        domBuilder.endDocument();
      }
    };
    var ENTITY_REG = /&#?\w+;?/g;
    function parse(source, defaultNSMapCopy, entityMap, domBuilder, errorHandler) {
      var isHTML = isHTMLMimeType(domBuilder.mimeType);
      if (source.indexOf(g.UNICODE_REPLACEMENT_CHARACTER) >= 0) {
        errorHandler.warning("Unicode replacement character detected, source encoding issues?");
      }
      function fixedFromCharCode(code) {
        if (code > 65535) {
          code -= 65536;
          var surrogate1 = 55296 + (code >> 10), surrogate2 = 56320 + (code & 1023);
          return String.fromCharCode(surrogate1, surrogate2);
        } else {
          return String.fromCharCode(code);
        }
      }
      function entityReplacer(a2) {
        var complete = a2[a2.length - 1] === ";" ? a2 : a2 + ";";
        if (!isHTML && complete !== a2) {
          errorHandler.error("EntityRef: expecting ;");
          return a2;
        }
        var match = g.Reference.exec(complete);
        if (!match || match[0].length !== complete.length) {
          errorHandler.error("entity not matching Reference production: " + a2);
          return a2;
        }
        var k = complete.slice(1, -1);
        if (hasOwn(entityMap, k)) {
          return entityMap[k];
        } else if (k.charAt(0) === "#") {
          return fixedFromCharCode(parseInt(k.substring(1).replace("x", "0x")));
        } else {
          errorHandler.error("entity not found:" + a2);
          return a2;
        }
      }
      function appendText(end2) {
        if (end2 > start) {
          var xt = source.substring(start, end2).replace(ENTITY_REG, entityReplacer);
          locator && position(start);
          domBuilder.characters(xt, 0, end2 - start);
          start = end2;
        }
      }
      var lineStart = 0;
      var lineEnd = 0;
      var linePattern = /\r\n?|\n|$/g;
      var locator = domBuilder.locator;
      function position(p, m) {
        while (p >= lineEnd && (m = linePattern.exec(source))) {
          lineStart = lineEnd;
          lineEnd = m.index + m[0].length;
          locator.lineNumber++;
        }
        locator.columnNumber = p - lineStart + 1;
      }
      var parseStack = [{ currentNSMap: defaultNSMapCopy }];
      var unclosedTags = [];
      var start = 0;
      while (true) {
        try {
          var tagStart = source.indexOf("<", start);
          if (tagStart < 0) {
            if (!isHTML && unclosedTags.length > 0) {
              return errorHandler.fatalError("unclosed xml tag(s): " + unclosedTags.join(", "));
            }
            if (!source.substring(start).match(/^\s*$/)) {
              var doc = domBuilder.doc;
              var text = doc.createTextNode(source.substring(start));
              if (doc.documentElement) {
                return errorHandler.error("Extra content at the end of the document");
              }
              doc.appendChild(text);
              domBuilder.currentElement = text;
            }
            return;
          }
          if (tagStart > start) {
            var fromSource = source.substring(start, tagStart);
            if (!isHTML && unclosedTags.length === 0) {
              fromSource = fromSource.replace(new RegExp(g.S_OPT.source, "g"), "");
              fromSource && errorHandler.error("Unexpected content outside root element: '" + fromSource + "'");
            }
            appendText(tagStart);
          }
          switch (source.charAt(tagStart + 1)) {
            case "/":
              var end = source.indexOf(">", tagStart + 2);
              var tagNameRaw = source.substring(tagStart + 2, end > 0 ? end : void 0);
              if (!tagNameRaw) {
                return errorHandler.fatalError("end tag name missing");
              }
              var endTagNameStrict = g.reg("^", g.QName_group, g.S_OPT, "$");
              var tagNameMatch = end > 0 && endTagNameStrict.exec(tagNameRaw);
              if (!tagNameMatch) {
                var leadingTagNameMatch = end > 0 && g.reg("^", g.QName_group).exec(tagNameRaw);
                if (isHTML && leadingTagNameMatch) {
                  errorHandler.warning('end tag name contains invalid trailing characters: "' + tagNameRaw + '"');
                  tagNameMatch = leadingTagNameMatch;
                } else if (
                  // Backward compatibility, remove this whole `else if` arm in the next breaking release
                  // (XML then falls through to the `fatalError` below, for a clean mode split: XML fatal,
                  // HTML warning). A valid end-tag name followed by a line break and trailing content was
                  // silently accepted while `reg` still used the `m` flag; re-adding `m` here matches exactly
                  // those inputs, kept recoverable and reported.
                  leadingTagNameMatch && new RegExp(endTagNameStrict.source, endTagNameStrict.flags + "m").test(tagNameRaw)
                ) {
                  errorHandler.error('end tag name is followed by a line break and trailing content: "' + tagNameRaw + '"');
                  tagNameMatch = leadingTagNameMatch;
                } else {
                  return errorHandler.fatalError('end tag name contains invalid characters: "' + tagNameRaw + '"');
                }
              }
              if (!domBuilder.currentElement && !domBuilder.doc.documentElement) {
                return;
              }
              var currentTagName = unclosedTags[unclosedTags.length - 1] || domBuilder.currentElement.tagName || domBuilder.doc.documentElement.tagName || "";
              if (currentTagName !== tagNameMatch[1]) {
                var tagNameLower = tagNameMatch[1].toLowerCase();
                if (!isHTML || currentTagName.toLowerCase() !== tagNameLower) {
                  return errorHandler.fatalError('Opening and ending tag mismatch: "' + currentTagName + '" != "' + tagNameRaw + '"');
                }
              }
              var config = parseStack.pop();
              unclosedTags.pop();
              var localNSMap = config.localNSMap;
              domBuilder.endElement(config.uri, config.localName, currentTagName);
              if (localNSMap) {
                for (var prefix in localNSMap) {
                  if (hasOwn(localNSMap, prefix)) {
                    domBuilder.endPrefixMapping(prefix);
                  }
                }
              }
              end++;
              break;
            // end element
            case "?":
              locator && position(tagStart);
              end = parseProcessingInstruction(source, tagStart, domBuilder, errorHandler);
              break;
            case "!":
              locator && position(tagStart);
              end = parseDoctypeCommentOrCData(source, tagStart, domBuilder, errorHandler, isHTML);
              break;
            default:
              locator && position(tagStart);
              var el = new ElementAttributes();
              var currentNSMap = parseStack[parseStack.length - 1].currentNSMap;
              var end = parseElementStartPart(source, tagStart, el, currentNSMap, entityReplacer, errorHandler, isHTML);
              var len = el.length;
              if (!el.closed) {
                if (isHTML && conventions.isHTMLVoidElement(el.tagName)) {
                  el.closed = true;
                } else {
                  unclosedTags.push(el.tagName);
                }
              }
              if (locator && len) {
                var locator2 = copyLocator(locator, {});
                for (var i = 0; i < len; i++) {
                  var a = el[i];
                  position(a.offset);
                  a.locator = copyLocator(locator, {});
                }
                domBuilder.locator = locator2;
                if (appendElement(el, domBuilder, currentNSMap)) {
                  parseStack.push(el);
                }
                domBuilder.locator = locator;
              } else {
                if (appendElement(el, domBuilder, currentNSMap)) {
                  parseStack.push(el);
                }
              }
              if (isHTML && !el.closed) {
                end = parseHtmlSpecialContent(source, end, el.tagName, entityReplacer, domBuilder);
              } else {
                end++;
              }
          }
        } catch (e) {
          if (e instanceof ParseError) {
            throw e;
          } else if (e instanceof DOMException) {
            return errorHandler.fatalError("Error constructing the DOM: " + e.name + ": " + e.message, e);
          }
          errorHandler.error("element parse error: " + e);
          end = -1;
        }
        if (end > start) {
          start = end;
        } else {
          appendText(Math.max(tagStart, start) + 1);
        }
      }
    }
    function copyLocator(f, t) {
      t.lineNumber = f.lineNumber;
      t.columnNumber = f.columnNumber;
      return t;
    }
    function parseElementStartPart(source, start, el, currentNSMap, entityReplacer, errorHandler, isHTML) {
      function addAttribute(qname2, value2, startIndex) {
        if (hasOwn(el.attributeNames, qname2)) {
          return errorHandler.fatalError("Attribute " + qname2 + " redefined");
        }
        if (!isHTML && value2.indexOf("<") >= 0) {
          return errorHandler.fatalError("Unescaped '<' not allowed in attributes values");
        }
        el.addValue(
          qname2,
          // @see https://www.w3.org/TR/xml/#AVNormalize
          // since the xmldom sax parser does not "interpret" DTD the following is not implemented:
          // - recursive replacement of (DTD) entity references
          // - trimming and collapsing multiple spaces into a single one for attributes that are not of type CDATA
          value2.replace(/[\t\n\r]/g, " ").replace(ENTITY_REG, entityReplacer),
          startIndex
        );
      }
      var attrName;
      var value;
      var p = ++start;
      var s = S_TAG;
      while (true) {
        var c = source.charAt(p);
        if (s === S_TAG && c === "<") {
          throw new Error("unexpected < in tag name: " + source.slice(start, p));
        }
        switch (c) {
          case "=":
            if (s === S_ATTR) {
              attrName = source.slice(start, p);
              s = S_EQ;
            } else if (s === S_ATTR_SPACE) {
              s = S_EQ;
            } else {
              throw new Error("attribute equal must after attrName");
            }
            break;
          case "'":
          case '"':
            if (s === S_EQ || s === S_ATTR) {
              if (s === S_ATTR) {
                errorHandler.warning('attribute value must after "="');
                attrName = source.slice(start, p);
              }
              start = p + 1;
              p = source.indexOf(c, start);
              if (p > 0) {
                value = source.slice(start, p);
                addAttribute(attrName, value, start - 1);
                s = S_ATTR_END;
              } else {
                throw new Error("attribute value no end '" + c + "' match");
              }
            } else if (s == S_ATTR_NOQUOT_VALUE) {
              value = source.slice(start, p);
              addAttribute(attrName, value, start);
              errorHandler.warning('attribute "' + attrName + '" missed start quot(' + c + ")!!");
              start = p + 1;
              s = S_ATTR_END;
            } else {
              throw new Error('attribute value must after "="');
            }
            break;
          case "/":
            switch (s) {
              case S_TAG:
                el.setTagName(source.slice(start, p));
              case S_ATTR_END:
              case S_TAG_SPACE:
              case S_TAG_CLOSE:
                s = S_TAG_CLOSE;
                el.closed = true;
              case S_ATTR_NOQUOT_VALUE:
              case S_ATTR:
                break;
              case S_ATTR_SPACE:
                el.closed = true;
                break;
              //case S_EQ:
              default:
                throw new Error("attribute invalid close char('/')");
            }
            break;
          case "":
            errorHandler.error("unexpected end of input");
            if (s == S_TAG) {
              el.setTagName(source.slice(start, p));
            }
            return p;
          case ">":
            switch (s) {
              case S_TAG:
                el.setTagName(source.slice(start, p));
              case S_ATTR_END:
              case S_TAG_SPACE:
              case S_TAG_CLOSE:
                break;
              //normal
              case S_ATTR_NOQUOT_VALUE:
              //Compatible state
              case S_ATTR:
                value = source.slice(start, p);
                if (value.slice(-1) === "/") {
                  el.closed = true;
                  value = value.slice(0, -1);
                }
              case S_ATTR_SPACE:
                if (s === S_ATTR_SPACE) {
                  value = attrName;
                }
                if (s == S_ATTR_NOQUOT_VALUE) {
                  errorHandler.warning('attribute "' + value + '" missed quot(")!');
                  addAttribute(attrName, value, start);
                } else {
                  if (!isHTML) {
                    errorHandler.warning('attribute "' + value + '" missed value!! "' + value + '" instead!!');
                  }
                  addAttribute(value, value, start);
                }
                break;
              case S_EQ:
                if (!isHTML) {
                  return errorHandler.fatalError(`AttValue: ' or " expected`);
                }
            }
            return p;
          /*xml space '\x20' | #x9 | #xD | #xA; */
          case "":
            c = " ";
          default:
            if (c <= " ") {
              switch (s) {
                case S_TAG:
                  el.setTagName(source.slice(start, p));
                  s = S_TAG_SPACE;
                  break;
                case S_ATTR:
                  attrName = source.slice(start, p);
                  s = S_ATTR_SPACE;
                  break;
                case S_ATTR_NOQUOT_VALUE:
                  var value = source.slice(start, p);
                  errorHandler.warning('attribute "' + value + '" missed quot(")!!');
                  addAttribute(attrName, value, start);
                case S_ATTR_END:
                  s = S_TAG_SPACE;
                  break;
              }
            } else {
              switch (s) {
                //case S_TAG:void();break;
                //case S_ATTR:void();break;
                //case S_ATTR_NOQUOT_VALUE:void();break;
                case S_ATTR_SPACE:
                  if (!isHTML) {
                    errorHandler.warning('attribute "' + attrName + '" missed value!! "' + attrName + '" instead2!!');
                  }
                  addAttribute(attrName, attrName, start);
                  start = p;
                  s = S_ATTR;
                  break;
                case S_ATTR_END:
                  errorHandler.warning('attribute space is required"' + attrName + '"!!');
                case S_TAG_SPACE:
                  s = S_ATTR;
                  start = p;
                  break;
                case S_EQ:
                  s = S_ATTR_NOQUOT_VALUE;
                  start = p;
                  break;
                case S_TAG_CLOSE:
                  throw new Error("elements closed character '/' and '>' must be connected to");
              }
            }
        }
        p++;
      }
    }
    function appendElement(el, domBuilder, currentNSMap) {
      var tagName = el.tagName;
      var localNSMap = null;
      var i = el.length;
      while (i--) {
        var a = el[i];
        var qName = a.qName;
        var value = a.value;
        var nsp = qName.indexOf(":");
        if (nsp > 0) {
          var prefix = a.prefix = qName.slice(0, nsp);
          var localName = qName.slice(nsp + 1);
          var nsPrefix = prefix === "xmlns" && localName;
        } else {
          localName = qName;
          prefix = null;
          nsPrefix = qName === "xmlns" && "";
        }
        a.localName = localName;
        if (nsPrefix !== false) {
          if (localNSMap == null) {
            localNSMap = /* @__PURE__ */ Object.create(null);
            currentNSMap = Object.create(currentNSMap);
          }
          currentNSMap[nsPrefix] = localNSMap[nsPrefix] = value;
          a.uri = NAMESPACE.XMLNS;
          domBuilder.startPrefixMapping(nsPrefix, value);
        }
      }
      var i = el.length;
      while (i--) {
        a = el[i];
        if (a.prefix) {
          if (a.prefix === "xml") {
            a.uri = NAMESPACE.XML;
          }
          if (a.prefix !== "xmlns") {
            a.uri = currentNSMap[a.prefix];
          }
        }
      }
      var nsp = tagName.indexOf(":");
      if (nsp > 0) {
        prefix = el.prefix = tagName.slice(0, nsp);
        localName = el.localName = tagName.slice(nsp + 1);
      } else {
        prefix = null;
        localName = el.localName = tagName;
      }
      var ns = el.uri = currentNSMap[prefix || ""];
      domBuilder.startElement(ns, localName, tagName, el);
      if (el.closed) {
        domBuilder.endElement(ns, localName, tagName);
        if (localNSMap) {
          for (prefix in localNSMap) {
            if (hasOwn(localNSMap, prefix)) {
              domBuilder.endPrefixMapping(prefix);
            }
          }
        }
      } else {
        el.currentNSMap = currentNSMap;
        el.localNSMap = localNSMap;
        return true;
      }
    }
    function parseHtmlSpecialContent(source, elStartEnd, tagName, entityReplacer, domBuilder) {
      var isEscapableRaw = isHTMLEscapableRawTextElement(tagName);
      if (isEscapableRaw || isHTMLRawTextElement(tagName)) {
        var closeTag = new RegExp("</" + tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ">", "ig");
        closeTag.lastIndex = elStartEnd;
        var match = closeTag.exec(source);
        var elEndStart = match ? match.index : -1;
        if (elEndStart < 0) {
          return elStartEnd + 1;
        }
        var text = source.substring(elStartEnd + 1, elEndStart);
        if (isEscapableRaw) {
          text = text.replace(ENTITY_REG, entityReplacer);
        }
        domBuilder.characters(text, 0, text.length);
        return elEndStart;
      }
      return elStartEnd + 1;
    }
    function _copy(source, target) {
      for (var n in source) {
        if (hasOwn(source, n)) {
          target[n] = source[n];
        }
      }
    }
    function parseUtils(source, start) {
      var index = start;
      function char(n) {
        n = n || 0;
        return source.charAt(index + n);
      }
      function skip(n) {
        n = n || 1;
        index += n;
      }
      function skipBlanks() {
        var blanks = 0;
        while (index < source.length) {
          var c = char();
          if (c !== " " && c !== "\n" && c !== "	" && c !== "\r") {
            return blanks;
          }
          blanks++;
          skip();
        }
        return -1;
      }
      function substringFromIndex() {
        return source.substring(index);
      }
      function substringStartsWith(text) {
        return source.substring(index, index + text.length) === text;
      }
      function substringStartsWithCaseInsensitive(text) {
        return source.substring(index, index + text.length).toUpperCase() === text.toUpperCase();
      }
      function getMatch(args) {
        var expr = g.reg("^", args);
        var match = expr.exec(substringFromIndex());
        if (match) {
          skip(match[0].length);
          return match[0];
        }
        return null;
      }
      return {
        char,
        getIndex: function() {
          return index;
        },
        getMatch,
        getSource: function() {
          return source;
        },
        skip,
        skipBlanks,
        substringFromIndex,
        substringStartsWith,
        substringStartsWithCaseInsensitive
      };
    }
    function parseDoctypeInternalSubset(p, errorHandler) {
      function parsePI(p2, errorHandler2) {
        var match = g.PI.exec(p2.substringFromIndex());
        if (!match) {
          return errorHandler2.fatalError("processing instruction is not well-formed at position " + p2.getIndex());
        }
        if (match[1].toLowerCase() === "xml") {
          return errorHandler2.fatalError(
            "xml declaration is only allowed at the start of the document, but found at position " + p2.getIndex()
          );
        }
        p2.skip(match[0].length);
        return match[0];
      }
      var source = p.getSource();
      if (p.char() === "[") {
        p.skip(1);
        var intSubsetStart = p.getIndex();
        while (p.getIndex() < source.length) {
          p.skipBlanks();
          if (p.char() === "]") {
            var internalSubset = source.substring(intSubsetStart, p.getIndex());
            p.skip(1);
            return internalSubset;
          }
          var current = null;
          if (p.char() === "<" && p.char(1) === "!") {
            switch (p.char(2)) {
              case "E":
                if (p.char(3) === "L") {
                  current = p.getMatch(g.elementdecl);
                } else if (p.char(3) === "N") {
                  current = p.getMatch(g.EntityDecl);
                }
                break;
              case "A":
                current = p.getMatch(g.AttlistDecl);
                break;
              case "N":
                current = p.getMatch(g.NotationDecl);
                break;
              case "-":
                current = p.getMatch(g.Comment);
                break;
            }
          } else if (p.char() === "<" && p.char(1) === "?") {
            current = parsePI(p, errorHandler);
          } else if (p.char() === "%") {
            current = p.getMatch(g.PEReference);
          } else {
            return errorHandler.fatalError("Error detected in Markup declaration");
          }
          if (!current) {
            return errorHandler.fatalError("Error in internal subset at position " + p.getIndex());
          }
        }
        return errorHandler.fatalError("doctype internal subset is not well-formed, missing ]");
      }
    }
    function parseDoctypeCommentOrCData(source, start, domBuilder, errorHandler, isHTML) {
      var p = parseUtils(source, start);
      switch (isHTML ? p.char(2).toUpperCase() : p.char(2)) {
        case "-":
          var comment = p.getMatch(g.Comment);
          if (comment) {
            domBuilder.comment(comment, g.COMMENT_START.length, comment.length - g.COMMENT_START.length - g.COMMENT_END.length);
            return p.getIndex();
          } else {
            return errorHandler.fatalError("comment is not well-formed at position " + p.getIndex());
          }
        case "[":
          var cdata = p.getMatch(g.CDSect);
          if (cdata) {
            if (!isHTML && !domBuilder.currentElement) {
              return errorHandler.fatalError("CDATA outside of element");
            }
            domBuilder.startCDATA();
            domBuilder.characters(cdata, g.CDATA_START.length, cdata.length - g.CDATA_START.length - g.CDATA_END.length);
            domBuilder.endCDATA();
            return p.getIndex();
          } else {
            return errorHandler.fatalError("Invalid CDATA starting at position " + start);
          }
        case "D": {
          if (domBuilder.doc && domBuilder.doc.documentElement) {
            return errorHandler.fatalError("Doctype not allowed inside or after documentElement at position " + p.getIndex());
          }
          if (isHTML ? !p.substringStartsWithCaseInsensitive(g.DOCTYPE_DECL_START) : !p.substringStartsWith(g.DOCTYPE_DECL_START)) {
            return errorHandler.fatalError("Expected " + g.DOCTYPE_DECL_START + " at position " + p.getIndex());
          }
          p.skip(g.DOCTYPE_DECL_START.length);
          if (p.skipBlanks() < 1) {
            return errorHandler.fatalError("Expected whitespace after " + g.DOCTYPE_DECL_START + " at position " + p.getIndex());
          }
          var doctype = {
            name: void 0,
            publicId: void 0,
            systemId: void 0,
            internalSubset: void 0
          };
          doctype.name = p.getMatch(g.Name);
          if (!doctype.name)
            return errorHandler.fatalError("doctype name missing or contains unexpected characters at position " + p.getIndex());
          if (isHTML && doctype.name.toLowerCase() !== "html") {
            errorHandler.warning("Unexpected DOCTYPE in HTML document at position " + p.getIndex());
          }
          p.skipBlanks();
          if (p.substringStartsWith(g.PUBLIC) || p.substringStartsWith(g.SYSTEM)) {
            var match = g.ExternalID_match.exec(p.substringFromIndex());
            if (!match) {
              return errorHandler.fatalError("doctype external id is not well-formed at position " + p.getIndex());
            }
            if (match.groups.SystemLiteralOnly !== void 0) {
              doctype.systemId = match.groups.SystemLiteralOnly;
            } else {
              doctype.systemId = match.groups.SystemLiteral;
              doctype.publicId = match.groups.PubidLiteral;
            }
            p.skip(match[0].length);
          } else if (isHTML && p.substringStartsWithCaseInsensitive(g.SYSTEM)) {
            p.skip(g.SYSTEM.length);
            if (p.skipBlanks() < 1) {
              return errorHandler.fatalError("Expected whitespace after " + g.SYSTEM + " at position " + p.getIndex());
            }
            doctype.systemId = p.getMatch(g.ABOUT_LEGACY_COMPAT_SystemLiteral);
            if (!doctype.systemId) {
              return errorHandler.fatalError(
                "Expected " + g.ABOUT_LEGACY_COMPAT + " in single or double quotes after " + g.SYSTEM + " at position " + p.getIndex()
              );
            }
          }
          if (isHTML && doctype.systemId && !g.ABOUT_LEGACY_COMPAT_SystemLiteral.test(doctype.systemId)) {
            errorHandler.warning("Unexpected doctype.systemId in HTML document at position " + p.getIndex());
          }
          if (!isHTML) {
            p.skipBlanks();
            doctype.internalSubset = parseDoctypeInternalSubset(p, errorHandler);
          }
          p.skipBlanks();
          if (p.char() !== ">") {
            return errorHandler.fatalError("doctype not terminated with > at position " + p.getIndex());
          }
          p.skip(1);
          domBuilder.startDTD(doctype.name, doctype.publicId, doctype.systemId, doctype.internalSubset);
          domBuilder.endDTD();
          return p.getIndex();
        }
        default:
          return errorHandler.fatalError('Not well-formed XML starting with "<!" at position ' + start);
      }
    }
    function parseProcessingInstruction(source, start, domBuilder, errorHandler) {
      var match = source.substring(start).match(g.PI);
      if (!match) {
        return errorHandler.fatalError("Invalid processing instruction starting at position " + start);
      }
      if (match[1].toLowerCase() === "xml") {
        if (start > 0) {
          return errorHandler.fatalError(
            "processing instruction at position " + start + " is an xml declaration which is only at the start of the document"
          );
        }
        if (!g.XMLDecl.test(source.substring(start))) {
          return errorHandler.fatalError("xml declaration is not well-formed");
        }
      }
      domBuilder.processingInstruction(match[1], match[2]);
      return start + match[0].length;
    }
    function ElementAttributes() {
      this.attributeNames = /* @__PURE__ */ Object.create(null);
    }
    ElementAttributes.prototype = {
      setTagName: function(tagName) {
        if (!g.QName_exact.test(tagName)) {
          throw new Error("invalid tagName:" + tagName);
        }
        this.tagName = tagName;
      },
      addValue: function(qName, value, offset) {
        if (!g.QName_exact.test(qName)) {
          throw new Error("invalid attribute:" + qName);
        }
        this.attributeNames[qName] = this.length;
        this[this.length++] = { qName, value, offset };
      },
      length: 0,
      getLocalName: function(i) {
        return this[i].localName;
      },
      getLocator: function(i) {
        return this[i].locator;
      },
      getQName: function(i) {
        return this[i].qName;
      },
      getURI: function(i) {
        return this[i].uri;
      },
      getValue: function(i) {
        return this[i].value;
      }
      //	,getIndex:function(uri, localName)){
      //		if(localName){
      //
      //		}else{
      //			var qName = uri
      //		}
      //	},
      //	getValue:function(){return this.getValue(this.getIndex.apply(this,arguments))},
      //	getType:function(uri,localName){}
      //	getType:function(i){},
    };
    exports.XMLReader = XMLReader;
    exports.parseUtils = parseUtils;
    exports.parseDoctypeCommentOrCData = parseDoctypeCommentOrCData;
  }
});

// node_modules/@xmldom/xmldom/lib/dom-parser.js
var require_dom_parser = __commonJS({
  "node_modules/@xmldom/xmldom/lib/dom-parser.js"(exports) {
    "use strict";
    var conventions = require_conventions();
    var dom = require_dom();
    var errors = require_errors();
    var entities = require_entities();
    var sax = require_sax();
    var DOMImplementation = dom.DOMImplementation;
    var hasDefaultHTMLNamespace = conventions.hasDefaultHTMLNamespace;
    var isHTMLMimeType = conventions.isHTMLMimeType;
    var isValidMimeType = conventions.isValidMimeType;
    var MIME_TYPE = conventions.MIME_TYPE;
    var NAMESPACE = conventions.NAMESPACE;
    var ParseError = errors.ParseError;
    var XMLReader = sax.XMLReader;
    function normalizeLineEndings(input) {
      return input.replace(/\r[\n\u0085]/g, "\n").replace(/[\r\u0085\u2028\u2029]/g, "\n");
    }
    function DOMParser2(options) {
      options = options || {};
      if (options.locator === void 0) {
        options.locator = true;
      }
      this.assign = options.assign || conventions.assign;
      this.domHandler = options.domHandler || DOMHandler;
      this.onError = options.onError || options.errorHandler;
      if (options.errorHandler && typeof options.errorHandler !== "function") {
        throw new TypeError("errorHandler object is no longer supported, switch to onError!");
      } else if (options.errorHandler) {
        options.errorHandler("warning", "The `errorHandler` option has been deprecated, use `onError` instead!", this);
      }
      this.normalizeLineEndings = options.normalizeLineEndings || normalizeLineEndings;
      this.locator = !!options.locator;
      this.xmlns = this.assign(/* @__PURE__ */ Object.create(null), options.xmlns);
    }
    DOMParser2.prototype.parseFromString = function(source, mimeType) {
      if (!isValidMimeType(mimeType)) {
        throw new TypeError('DOMParser.parseFromString: the provided mimeType "' + mimeType + '" is not valid.');
      }
      var defaultNSMap = this.assign(/* @__PURE__ */ Object.create(null), this.xmlns);
      var entityMap = entities.XML_ENTITIES;
      var defaultNamespace = defaultNSMap[""] || null;
      if (hasDefaultHTMLNamespace(mimeType)) {
        entityMap = entities.HTML_ENTITIES;
        defaultNamespace = NAMESPACE.HTML;
      } else if (mimeType === MIME_TYPE.XML_SVG_IMAGE) {
        defaultNamespace = NAMESPACE.SVG;
      }
      defaultNSMap[""] = defaultNamespace;
      defaultNSMap.xml = defaultNSMap.xml || NAMESPACE.XML;
      var domBuilder = new this.domHandler({
        mimeType,
        defaultNamespace,
        onError: this.onError
      });
      var locator = this.locator ? {} : void 0;
      if (this.locator) {
        domBuilder.setDocumentLocator(locator);
      }
      var sax2 = new XMLReader();
      sax2.errorHandler = domBuilder;
      sax2.domBuilder = domBuilder;
      var isXml = !conventions.isHTMLMimeType(mimeType);
      if (isXml && typeof source !== "string") {
        sax2.errorHandler.fatalError("source is not a string");
      }
      sax2.parse(this.normalizeLineEndings(String(source)), defaultNSMap, entityMap);
      if (!domBuilder.doc.documentElement) {
        sax2.errorHandler.fatalError("missing root element");
      }
      return domBuilder.doc;
    };
    function DOMHandler(options) {
      var opt = options || {};
      this.mimeType = opt.mimeType || MIME_TYPE.XML_APPLICATION;
      this.defaultNamespace = opt.defaultNamespace || null;
      this.cdata = false;
      this.currentElement = void 0;
      this.doc = void 0;
      this.locator = void 0;
      this.onError = opt.onError;
    }
    function position(locator, node) {
      node.lineNumber = locator.lineNumber;
      node.columnNumber = locator.columnNumber;
    }
    DOMHandler.prototype = {
      /**
       * Either creates an XML or an HTML document and stores it under `this.doc`.
       * If it is an XML document, `this.defaultNamespace` is used to create it,
       * and it will not contain any `childNodes`.
       * If it is an HTML document, it will be created without any `childNodes`.
       *
       * @see http://www.saxproject.org/apidoc/org/xml/sax/ContentHandler.html
       */
      startDocument: function() {
        var impl = new DOMImplementation();
        this.doc = isHTMLMimeType(this.mimeType) ? impl.createHTMLDocument(false) : impl.createDocument(this.defaultNamespace, "");
      },
      startElement: function(namespaceURI, localName, qName, attrs) {
        var doc = this.doc;
        var el = doc.createElementNS(namespaceURI, qName || localName);
        var len = attrs.length;
        appendElement(this, el);
        this.currentElement = el;
        this.locator && position(this.locator, el);
        for (var i = 0; i < len; i++) {
          var namespaceURI = attrs.getURI(i);
          var value = attrs.getValue(i);
          var qName = attrs.getQName(i);
          var attr = doc.createAttributeNS(namespaceURI, qName);
          this.locator && position(attrs.getLocator(i), attr);
          attr.value = attr.nodeValue = value;
          el.setAttributeNode(attr);
        }
      },
      endElement: function(namespaceURI, localName, qName) {
        this.currentElement = this.currentElement.parentNode;
      },
      startPrefixMapping: function(prefix, uri) {
      },
      endPrefixMapping: function(prefix) {
      },
      processingInstruction: function(target, data) {
        var ins = this.doc.createProcessingInstruction(target, data);
        this.locator && position(this.locator, ins);
        appendElement(this, ins);
      },
      ignorableWhitespace: function(ch, start, length) {
      },
      characters: function(chars, start, length) {
        chars = _toString.apply(this, arguments);
        if (chars) {
          if (this.cdata) {
            var charNode = this.doc.createCDATASection(chars);
          } else {
            var charNode = this.doc.createTextNode(chars);
          }
          if (this.currentElement) {
            this.currentElement.appendChild(charNode);
          } else if (/^\s*$/.test(chars)) {
            this.doc.appendChild(charNode);
          }
          this.locator && position(this.locator, charNode);
        }
      },
      skippedEntity: function(name) {
      },
      endDocument: function() {
        this.doc.normalize();
      },
      /**
       * Stores the locator to be able to set the `columnNumber` and `lineNumber`
       * on the created DOM nodes.
       *
       * @param {Locator} locator
       */
      setDocumentLocator: function(locator) {
        if (locator) {
          locator.lineNumber = 0;
        }
        this.locator = locator;
      },
      //LexicalHandler
      comment: function(chars, start, length) {
        chars = _toString.apply(this, arguments);
        var comm = this.doc.createComment(chars);
        this.locator && position(this.locator, comm);
        appendElement(this, comm);
      },
      startCDATA: function() {
        this.cdata = true;
      },
      endCDATA: function() {
        this.cdata = false;
      },
      startDTD: function(name, publicId, systemId, internalSubset) {
        var impl = this.doc.implementation;
        if (impl && impl.createDocumentType) {
          var dt = impl.createDocumentType(name, publicId, systemId, internalSubset);
          this.locator && position(this.locator, dt);
          appendElement(this, dt);
          this.doc.doctype = dt;
        }
      },
      reportError: function(level, message) {
        if (typeof this.onError === "function") {
          try {
            this.onError(level, message, this);
          } catch (e) {
            throw new ParseError("Reporting " + level + ' "' + message + '" caused ' + e, this.locator);
          }
        } else {
          console.error("[xmldom " + level + "]	" + message, _locator(this.locator));
        }
      },
      /**
       * @see http://www.saxproject.org/apidoc/org/xml/sax/ErrorHandler.html
       */
      warning: function(message) {
        this.reportError("warning", message);
      },
      error: function(message) {
        this.reportError("error", message);
      },
      /**
       * This function reports a fatal error and throws a ParseError.
       *
       * @param {string} message
       * - The message to be used for reporting and throwing the error.
       * @param {Error} [cause]
       * The error that caused this fatal error, preserved as the thrown `ParseError`'s `cause`.
       * @returns {never}
       * This function always throws an error and never returns a value.
       * @throws {ParseError}
       * Always throws a ParseError with the provided message.
       */
      fatalError: function(message, cause) {
        this.reportError("fatalError", message);
        throw new ParseError(message, this.locator, cause);
      }
    };
    function _locator(l) {
      if (l) {
        return "\n@#[line:" + l.lineNumber + ",col:" + l.columnNumber + "]";
      }
    }
    function _toString(chars, start, length) {
      if (typeof chars == "string") {
        return chars.substr(start, length);
      } else {
        if (chars.length >= start + length || start) {
          return new java.lang.String(chars, start, length) + "";
        }
        return chars;
      }
    }
    "endDTD,startEntity,endEntity,attributeDecl,elementDecl,externalEntityDecl,internalEntityDecl,resolveEntity,getExternalSubset,notationDecl,unparsedEntityDecl".replace(
      /\w+/g,
      function(key) {
        DOMHandler.prototype[key] = function() {
          return null;
        };
      }
    );
    function appendElement(handler, node) {
      if (!handler.currentElement) {
        handler.doc.appendChild(node);
      } else {
        handler.currentElement.appendChild(node);
      }
    }
    function onErrorStopParsing(level) {
      if (level === "error") throw "onErrorStopParsing";
    }
    function onWarningStopParsing() {
      throw "onWarningStopParsing";
    }
    exports.__DOMHandler = DOMHandler;
    exports.DOMParser = DOMParser2;
    exports.normalizeLineEndings = normalizeLineEndings;
    exports.onErrorStopParsing = onErrorStopParsing;
    exports.onWarningStopParsing = onWarningStopParsing;
  }
});

// node_modules/@xmldom/xmldom/lib/index.js
var require_lib = __commonJS({
  "node_modules/@xmldom/xmldom/lib/index.js"(exports) {
    "use strict";
    var conventions = require_conventions();
    exports.assign = conventions.assign;
    exports.hasDefaultHTMLNamespace = conventions.hasDefaultHTMLNamespace;
    exports.isHTMLMimeType = conventions.isHTMLMimeType;
    exports.isValidMimeType = conventions.isValidMimeType;
    exports.MIME_TYPE = conventions.MIME_TYPE;
    exports.NAMESPACE = conventions.NAMESPACE;
    var errors = require_errors();
    exports.DOMException = errors.DOMException;
    exports.DOMExceptionName = errors.DOMExceptionName;
    exports.ExceptionCode = errors.ExceptionCode;
    exports.ParseError = errors.ParseError;
    var dom = require_dom();
    exports.Attr = dom.Attr;
    exports.CDATASection = dom.CDATASection;
    exports.CharacterData = dom.CharacterData;
    exports.Comment = dom.Comment;
    exports.Document = dom.Document;
    exports.DocumentFragment = dom.DocumentFragment;
    exports.DocumentType = dom.DocumentType;
    exports.DOMImplementation = dom.DOMImplementation;
    exports.Element = dom.Element;
    exports.Entity = dom.Entity;
    exports.EntityReference = dom.EntityReference;
    exports.LiveNodeList = dom.LiveNodeList;
    exports.NamedNodeMap = dom.NamedNodeMap;
    exports.Node = dom.Node;
    exports.NodeList = dom.NodeList;
    exports.Notation = dom.Notation;
    exports.ProcessingInstruction = dom.ProcessingInstruction;
    exports.Text = dom.Text;
    exports.XMLSerializer = dom.XMLSerializer;
    var domParser = require_dom_parser();
    exports.DOMParser = domParser.DOMParser;
    exports.normalizeLineEndings = domParser.normalizeLineEndings;
    exports.onErrorStopParsing = domParser.onErrorStopParsing;
    exports.onWarningStopParsing = domParser.onWarningStopParsing;
  }
});

// src/office/cli.js
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { parseArgs } from "node:util";

// src/office/package.js
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";

// src/office/xml.js
var xml_exports = {};
__export(xml_exports, {
  NS: () => NS,
  XmlError: () => XmlError,
  childrenOf: () => childrenOf,
  elementsOf: () => elementsOf,
  firstOf: () => firstOf,
  parseXml: () => parseXml,
  parser: () => parser,
  prettyXml: () => prettyXml,
  qname: () => qname,
  serializeXml: () => serializeXml,
  stripPrettyWhitespace: () => stripPrettyWhitespace,
  textOf: () => textOf
});
var import_xmldom = __toESM(require_lib(), 1);
var NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  xml: "http://www.w3.org/XML/1998/namespace"
};
var parser = new import_xmldom.DOMParser({ onError: (level, message) => {
  throw new XmlError(message);
} });
var serializer = new import_xmldom.XMLSerializer();
var XmlError = class extends Error {
  constructor(message) {
    super(`XML not well-formed: ${message}`);
    this.code = "xml";
  }
};
function parseXml(text) {
  return parser.parseFromString(String(text), "text/xml");
}
function serializeXml(node) {
  return serializer.serializeToString(node);
}
function qname(ns, local) {
  return `${ns}:${local}`;
}
var TEXT_TAGS = /* @__PURE__ */ new Set(["w:t", "w:delText", "w:instrText", "a:t", "m:t"]);
function preserved(element) {
  for (let node = element; node && node.nodeType === 1; node = node.parentNode) {
    if (node.getAttribute?.("xml:space") === "preserve") return true;
  }
  return false;
}
function prettyXml(doc) {
  const indent = (node, depth) => {
    const children = [...node.childNodes];
    if (children.length === 0 || preserved(node) || children.some((child2) => child2.nodeType === 3 || child2.nodeType === 4)) return;
    const pad = "\n" + "  ".repeat(depth);
    for (const child2 of children) {
      if (child2.nodeType === 1) indent(child2, depth + 1);
      node.insertBefore(doc.createTextNode(pad), child2);
    }
    node.appendChild(doc.createTextNode("\n" + "  ".repeat(Math.max(0, depth - 1))));
  };
  indent(doc.documentElement, 1);
  return serializeXml(doc);
}
function stripPrettyWhitespace(doc) {
  const drop = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      if (node.data.trim() === "" && !preserved(node.parentNode) && !TEXT_TAGS.has(node.parentNode?.tagName)) drop.push(node);
      return;
    }
    for (const child2 of [...node.childNodes]) walk(child2);
  };
  walk(doc.documentElement);
  for (const node of drop) node.parentNode.removeChild(node);
}
function childrenOf(node, tag) {
  return [...node?.childNodes ?? []].filter((child2) => child2.nodeType === 1 && (tag === void 0 || child2.tagName === tag));
}
function elementsOf(node, tag) {
  const found = [];
  const walk = (el) => {
    if (el.nodeType !== 1) return;
    if (tag === void 0 || el.tagName === tag) found.push(el);
    for (const child2 of childrenOf(el)) walk(child2);
  };
  walk(node);
  return found;
}
function firstOf(node, tag) {
  if (node.tagName === tag && node.nodeType === 1) return node;
  for (const child2 of childrenOf(node)) {
    const hit = firstOf(child2, tag);
    if (hit) return hit;
  }
  return void 0;
}
function textOf(node, { skipDeleted = true } = {}) {
  let out = "";
  const walk = (el, deleted) => {
    if (el.nodeType === 3 || el.nodeType === 4) {
      if (!deleted) out += el.data;
      return;
    }
    if (el.nodeType !== 1) return;
    const gone = deleted || skipDeleted && (el.tagName === "w:del" || el.tagName === "w:moveFrom");
    for (const child2 of [...el.childNodes]) walk(child2, gone);
  };
  walk(node, false);
  return out;
}

// src/office/zip.js
import { deflateRawSync, inflateRawSync } from "node:zlib";
var EOCD = 101010256;
var CDIR = 33639248;
var LOCAL = 67324752;
function fail(message) {
  const error = new Error(message);
  error.code = "zip";
  throw error;
}
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail("not a ZIP file: no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 65535 || cdSize === 4294967295 || cdOff === 4294967295) fail("zip64 archives are not supported");
  const members = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cdOff) !== CDIR) fail("corrupt central directory");
    const flags = buf.readUInt16LE(cdOff + 8);
    const method = buf.readUInt16LE(cdOff + 10);
    const crc = buf.readUInt32LE(cdOff + 16);
    const csize = buf.readUInt32LE(cdOff + 20);
    const usize = buf.readUInt32LE(cdOff + 24);
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commentLen = buf.readUInt16LE(cdOff + 32);
    const localOff = buf.readUInt32LE(cdOff + 42);
    if (csize === 4294967295 || usize === 4294967295) fail("zip64 archives are not supported");
    const name = buf.subarray(cdOff + 46, cdOff + 46 + nameLen).toString("utf8");
    const norm = name.replace(/\\/g, "/");
    if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").includes("..")) fail(`zip: unsafe member name ${name}`);
    if (buf.readUInt32LE(localOff) !== LOCAL) fail(`corrupt local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(localOff + 30 + lNameLen + lExtraLen, localOff + 30 + lNameLen + lExtraLen + csize);
    let data;
    if (method === 0) data = raw.subarray(0, usize);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
      } catch (err) {
        if (err instanceof RangeError || err?.code === "ERR_OUT_OF_RANGE") fail(`${name} inflates past its declared size`);
        fail(`corrupt data for ${name}`);
      }
    } else fail(`unsupported compression method ${method} for ${name}`);
    if (data.length !== usize) fail(`size mismatch for ${name}`);
    members.push({ name, data, raw, method, crc, flags: flags & 2048, extra: buf.subarray(cdOff + 46 + nameLen, cdOff + 46 + nameLen + extraLen) });
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}
function writeZip(members) {
  const ordered = [...members].sort((a, b) => (a.name === "[Content_Types].xml" ? -1 : 0) - (b.name === "[Content_Types].xml" ? -1 : 0));
  const local = [], central = [];
  let offset = 0;
  for (const member of ordered) {
    const nameBuf = Buffer.from(member.name, "utf8");
    let raw, crc, usize, method;
    if (member.raw !== void 0 && member.data === void 0) {
      raw = member.raw;
      crc = member.crc;
      usize = member.usize;
      method = member.method;
      if (method === 0 && usize === void 0) usize = raw.length;
    } else {
      const plain = member.data ?? inflateRawSync(member.raw);
      method = member.method === 0 ? 0 : 8;
      raw = method === 0 ? plain : deflateRawSync(plain, { level: 9 });
      crc = crc32(plain);
      usize = plain.length;
    }
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(member.flags ?? 2048, 6);
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt32LE(crc >>> 0, 14);
    head.writeUInt32LE(raw.length, 18);
    head.writeUInt32LE(usize, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, nameBuf, raw);
    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(CDIR, 0);
    cent.writeUInt16LE(20, 4);
    cent.writeUInt16LE(20, 6);
    cent.writeUInt16LE(member.flags ?? 2048, 8);
    cent.writeUInt16LE(method, 10);
    cent.writeUInt16LE(0, 12);
    cent.writeUInt16LE(0, 14);
    cent.writeUInt32LE(crc >>> 0, 16);
    cent.writeUInt32LE(raw.length, 20);
    cent.writeUInt32LE(usize, 24);
    cent.writeUInt16LE(nameBuf.length, 28);
    cent.writeUInt32LE(0, 38);
    cent.writeUInt32LE(offset, 42);
    central.push(cent, nameBuf);
    offset += 30 + nameBuf.length + raw.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
var TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) crc = TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return ~crc >>> 0;
}

// src/office/package.js
function fail2(message) {
  const error = new Error(message);
  error.code = "package";
  throw error;
}
var absTarget = (base, target) => {
  if (target.startsWith("/")) return target.slice(1);
  return posix.normalize(posix.join(posix.dirname(base), target));
};
var relSig = (map) => [...map.values()].map((r) => `${r.id}${r.type}${r.target}${r.mode}`).join("");
var Package = class _Package {
  constructor() {
    this.parts = /* @__PURE__ */ new Map();
    this.rels = /* @__PURE__ */ new Map();
    this.defaults = /* @__PURE__ */ new Map();
    this.overrides = /* @__PURE__ */ new Map();
  }
  /** @param {string} file - a ZIP package file */
  static open(file) {
    const pkg = new _Package();
    for (const member of readZip(readFileSync(file))) {
      pkg.parts.set(member.name, { raw: member.raw, method: member.method, crc: member.crc, usize: member.data.length });
      pkg.#cache(member.name, member.data);
    }
    pkg.#readModel();
    return pkg;
  }
  /** @param {string} dir - a directory tree as `unpack` writes it */
  static loadDir(dir) {
    const pkg = new _Package();
    const walk = (base, rel) => {
      for (const entry of readdirSync(join(base, rel))) {
        const path = rel === "" ? entry : `${rel}/${entry}`;
        if (statSync(join(base, path)).isDirectory()) walk(base, path);
        else {
          const data = readFileSync(join(base, path));
          pkg.parts.set(path, { data });
          pkg.#cache(path, data);
        }
      }
    };
    walk(dir, "");
    pkg.#readModel();
    return pkg;
  }
  #cache(name, data) {
    (this.dataCache ??= /* @__PURE__ */ new Map()).set(name, data);
  }
  #readModel() {
    const ct = this.get("[Content_Types].xml");
    if (ct === void 0) fail2("[Content_Types].xml missing");
    const doc = parseXml(ct);
    for (const el of childrenOf(doc.documentElement)) {
      if (el.tagName === "Default") this.defaults.set(el.getAttribute("Extension"), el.getAttribute("ContentType"));
      else if (el.tagName === "Override") this.overrides.set(el.getAttribute("PartName").replace(/^\//, ""), el.getAttribute("ContentType"));
    }
    for (const name of this.parts.keys()) {
      if (!name.endsWith(".rels")) continue;
      const owner = name === "_rels/.rels" ? "" : posix.dirname(posix.dirname(name)) + "/" + posix.basename(name, ".rels");
      const map = /* @__PURE__ */ new Map();
      try {
        for (const rel of childrenOf(parseXml(this.get(name)).documentElement, "Relationship")) {
          map.set(rel.getAttribute("Id"), {
            id: rel.getAttribute("Id"),
            type: rel.getAttribute("Type"),
            target: rel.getAttribute("Target"),
            mode: rel.getAttribute("TargetMode") ?? "Internal"
          });
        }
      } catch {
      }
      this.rels.set(owner, map);
    }
    this.relSigs = new Map([...this.rels].map(([owner, map]) => [owner, relSig(map)]));
    this.ctSig = JSON.stringify([...this.defaults].sort().concat([...this.overrides].filter(([n]) => this.parts.has(n)).sort()));
  }
  /** @returns {Buffer|undefined} part bytes */
  get(name) {
    return this.dataCache?.get(name) ?? this.parts.get(name)?.data;
  }
  /** @returns {Document} parsed XML part */
  xml(name) {
    return parseXml(this.get(name));
  }
  /** Store XML text (or bytes) as a part, replacing its entry. */
  put(name, content) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    this.parts.set(name, { data });
    this.#cache(name, data);
  }
  putXml(name, doc) {
    this.put(name, serializeXml(doc));
  }
  remove(name) {
    this.parts.delete(name);
    this.dataCache?.delete(name);
  }
  /** @returns {string|undefined} content type for a part, from Override or Default */
  contentType(name) {
    return this.overrides.get(name) ?? this.defaults.get(name.slice(name.lastIndexOf(".") + 1));
  }
  /** Add or update an Override for a part. */
  override(name, type) {
    this.overrides.set(name, type);
  }
  /** The .rels owner name for a part ('word/document.xml' → itself, '' → package root). */
  relsOf(owner) {
    return this.rels.get(owner) ?? /* @__PURE__ */ new Map();
  }
  /** Absolute part name a relationship target resolves to. */
  targetOf(owner, target) {
    return absTarget(owner === "" ? "x" : owner, target);
  }
  /** @returns {{ id: string, type: string, target: string, mode: string }[]} relationships of a part (or package root) */
  relList(owner) {
    return [...this.relsOf(owner).values()];
  }
  /** @returns {string} the .rels part name for an owner part ('' for the package root). */
  relsName(owner) {
    return owner === "" ? "_rels/.rels" : `${posix.dirname(owner)}/_rels/${posix.basename(owner)}.rels`;
  }
  /** Write .rels and [Content_Types].xml back into parts from the model — a
   * .rels part changes only when its owner part is gone or its map's signature
   * differs from the load baseline, so malformed or empty-but-valid .rels keep
   * their bytes instead of being dropped. */
  flush() {
    for (const name of [...this.parts.keys()]) {
      if (!name.endsWith(".rels")) continue;
      const owner = this.#relsOwner(name);
      if (owner !== "" && !this.parts.has(owner)) this.parts.delete(name);
    }
    for (const [owner, map] of this.rels) {
      if (owner !== "" && !this.parts.has(owner)) {
        this.rels.delete(owner);
        continue;
      }
      const name = this.relsName(owner);
      const sig = relSig(map);
      const base = (this.relSigs ??= /* @__PURE__ */ new Map()).get(owner);
      if (map.size === 0) {
        if (base !== void 0 && base !== sig) this.parts.delete(name);
        continue;
      }
      if (sig === base && this.parts.has(name)) continue;
      const doc = parseXml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
      for (const rel of map.values()) {
        const el = doc.createElement("Relationship");
        el.setAttribute("Id", rel.id);
        el.setAttribute("Type", rel.type);
        el.setAttribute("Target", rel.target);
        if (rel.mode !== "Internal") el.setAttribute("TargetMode", rel.mode);
        doc.documentElement.appendChild(el);
      }
      this.putXml(name, doc);
      this.relSigs.set(owner, sig);
    }
    const ctSig = JSON.stringify([...this.defaults].sort().concat([...this.overrides].filter(([n]) => this.parts.has(n)).sort()));
    if (ctSig !== this.ctSig || !this.parts.has("[Content_Types].xml")) {
      const ct = parseXml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
      for (const [ext2, type] of this.defaults) {
        const el = ct.createElement("Default");
        el.setAttribute("Extension", ext2);
        el.setAttribute("ContentType", type);
        ct.documentElement.appendChild(el);
      }
      for (const [name, type] of this.overrides) {
        if (!this.parts.has(name)) continue;
        const el = ct.createElement("Override");
        el.setAttribute("PartName", `/${name}`);
        el.setAttribute("ContentType", type);
        ct.documentElement.appendChild(el);
      }
      this.putXml("[Content_Types].xml", ct);
      this.ctSig = ctSig;
    }
    this.parts.delete("");
  }
  #relsOwner(name) {
    return name === "_rels/.rels" ? "" : posix.dirname(posix.dirname(name)) + "/" + posix.basename(name, ".rels");
  }
  /** @returns {Buffer} the package as a ZIP */
  save() {
    this.flush();
    return writeZip([...this.parts.entries()].map(([name, part]) => ({ name, ...part })));
  }
  /** Write an `unpack` directory tree. An existing non-empty dir must hold an
   * earlier unpack ([Content_Types].xml at its root); files the package no
   * longer has are removed. The model is flushed first so .rels and content
   * types written to disk match the in-memory state. */
  unpack(dir) {
    this.flush();
    if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, "[Content_Types].xml"))) {
      fail2(`unpack: ${dir} exists and is not an earlier unpack`);
    }
    mkdirSync(dir, { recursive: true });
    const root = resolve(dir);
    const rootReal = realpathSync(dir);
    const keep = /* @__PURE__ */ new Set();
    for (const [name] of this.parts) {
      const file = join(dir, name);
      if (!resolve(file).startsWith(root + sep) && resolve(file) !== root) fail2(`unpack: unsafe member name ${name}`);
      keep.add(file);
      mkdirSync(dirname(file), { recursive: true });
      const parentReal = realpathSync(dirname(file));
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) fail2(`unpack: ${name} resolves outside ${dir}`);
      if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) fail2(`unpack: ${name} is a link`);
      const data = this.get(name);
      if (name.endsWith(".xml") || name.endsWith(".rels")) {
        try {
          writeFileSync(file, prettyForUnpack(data));
          continue;
        } catch {
        }
      }
      writeFileSync(file, data);
    }
    const sweep = (rel) => {
      for (const entry of readdirSync(join(dir, rel))) {
        const path = rel === "" ? entry : `${rel}/${entry}`;
        const full = join(dir, path);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) fail2(`unpack: link inside ${dir}`);
        if (st.isDirectory()) {
          sweep(path);
          if (readdirSync(full).length === 0) rmdirSync(full);
        } else if (!keep.has(full)) unlinkSync(full);
      }
    };
    sweep("");
  }
};
function prettyForUnpack(data) {
  const { prettyXml: prettyXml2 } = xml_exports;
  return prettyXml2(parseXml(data));
}

// src/office/check.js
import { posix as posix2 } from "node:path";
var KNOWN_OVERRIDES = {
  "word/document.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  "word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  "word/numbering.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
  "word/settings.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  "word/comments.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
  "word/footnotes.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
  "word/endnotes.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
  "word/fontTable.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
  "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  "xl/sharedStrings.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
  "xl/styles.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
  "ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  "docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
  "docProps/app.xml": "application/vnd.openxmlformats-officedocument.extended-properties+xml"
};
var patternType = (name) => {
  if (KNOWN_OVERRIDES[name]) return KNOWN_OVERRIDES[name];
  const base = "application/vnd.openxmlformats-officedocument.";
  if (/^word\/header\d+\.xml$/.test(name)) return base + "wordprocessingml.header+xml";
  if (/^word\/footer\d+\.xml$/.test(name)) return base + "wordprocessingml.footer+xml";
  if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) return base + "presentationml.slide+xml";
  if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)) return base + "presentationml.slideLayout+xml";
  if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)) return base + "presentationml.slideMaster+xml";
  if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)) return base + "presentationml.notesSlide+xml";
  if (/^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(name)) return base + "presentationml.notesMaster+xml";
  if (/^ppt\/theme\/theme\d+\.xml$/.test(name)) return base + "theme+xml";
  if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) return base + "spreadsheetml.worksheet+xml";
  if (/^xl\/theme\/theme\d+\.xml$/.test(name)) return base + "theme+xml";
  return void 0;
};
var finding = (rule, part, message) => ({ rule, part, key: `${rule}|${part}|${message}`, message });
function checkPackage(pkg, original) {
  const found = runRules(pkg);
  if (!original) return found;
  const before = new Set(runRules(original).map((f) => f.key));
  return found.filter((f) => !before.has(f.key));
}
function runRules(pkg) {
  const out = [];
  const xmlDocs = /* @__PURE__ */ new Map();
  for (const name of pkg.parts.keys()) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    try {
      xmlDocs.set(name, parseXml(pkg.get(name)));
    } catch (error) {
      out.push(finding("malformed-xml", name, error.message.slice(0, 200)));
    }
  }
  for (const name of pkg.parts.keys()) {
    if (pkg.contentType(name) === void 0 && !name.endsWith("/")) {
      out.push(finding("no-content-type", name, `${name} has no Default or Override`));
    }
  }
  for (const part of pkg.overrides.keys()) {
    if (!pkg.parts.has(part)) out.push(finding("override-absent-part", part, `Override names absent part /${part}`));
  }
  for (const name of [...pkg.parts.keys()].filter((n) => n.endsWith(".rels"))) {
    const doc = xmlDocs.get(name);
    if (!doc) continue;
    const owner = name === "_rels/.rels" ? "" : posix2.dirname(posix2.dirname(name)) + "/" + posix2.basename(name, ".rels");
    const seen = /* @__PURE__ */ new Set();
    for (const rel of childrenOf(doc.documentElement, "Relationship")) {
      const id = rel.getAttribute("Id");
      if (seen.has(id)) out.push(finding("duplicate-rel-id", name, `relationship id ${id} used twice`));
      seen.add(id);
      if ((rel.getAttribute("TargetMode") ?? "Internal") !== "External") {
        const target = pkg.targetOf(owner, rel.getAttribute("Target"));
        if (!pkg.parts.has(target)) out.push(finding("dangling-rel", name, `${id} → ${target} is absent`));
      }
    }
  }
  for (const [name, doc] of xmlDocs) {
    if (name.endsWith(".rels")) continue;
    const rels = pkg.relsOf(name);
    for (const el of elementsOf(doc.documentElement)) {
      for (const attr of ["r:id", "r:embed", "r:link", "r:dm", "r:lo", "r:qs", "r:cs"]) {
        const value = el.getAttribute?.(attr);
        if (value && !rels.has(value)) out.push(finding("unknown-rel-ref", name, `${el.tagName} ${attr}="${value}" has no relationship`));
      }
    }
  }
  contentTypeRules(pkg, out);
  const isPptx = pkg.parts.has("ppt/presentation.xml"), isDocx = pkg.parts.has("word/document.xml");
  if (isPptx) pptxRules(pkg, xmlDocs, out);
  if (isDocx) docxRules(pkg, xmlDocs, out);
  return out;
}
var CT_BASE = "application/vnd.openxmlformats-officedocument.";
var pkgKind = (pkg) => pkg.parts.has("word/document.xml") ? "docx" : pkg.parts.has("ppt/presentation.xml") ? "pptx" : pkg.parts.has("xl/workbook.xml") ? "xlsx" : void 0;
var MAIN_CT = { docx: CT_BASE + "wordprocessingml.document.main+xml", pptx: CT_BASE + "presentationml.presentation.main+xml", xlsx: CT_BASE + "spreadsheetml.sheet.main+xml" };
var REL_TYPE_CT = {
  officeDocument: MAIN_CT,
  document: MAIN_CT,
  styles: { docx: CT_BASE + "wordprocessingml.styles+xml", xlsx: CT_BASE + "spreadsheetml.styles+xml" },
  numbering: CT_BASE + "wordprocessingml.numbering+xml",
  settings: CT_BASE + "wordprocessingml.settings+xml",
  comments: CT_BASE + "wordprocessingml.comments+xml",
  footnotes: CT_BASE + "wordprocessingml.footnotes+xml",
  endnotes: CT_BASE + "wordprocessingml.endnotes+xml",
  header: CT_BASE + "wordprocessingml.header+xml",
  footer: CT_BASE + "wordprocessingml.footer+xml",
  fontTable: CT_BASE + "wordprocessingml.fontTable+xml",
  theme: CT_BASE + "theme+xml",
  slide: CT_BASE + "presentationml.slide+xml",
  slideLayout: CT_BASE + "presentationml.slideLayout+xml",
  slideMaster: CT_BASE + "presentationml.slideMaster+xml",
  notesSlide: CT_BASE + "presentationml.notesSlide+xml",
  notesMaster: CT_BASE + "presentationml.notesMaster+xml",
  chart: CT_BASE + "drawingml.chart+xml",
  worksheet: CT_BASE + "spreadsheetml.worksheet+xml",
  sharedStrings: CT_BASE + "spreadsheetml.sharedStrings+xml",
  coreProperties: "application/vnd.openxmlformats-package.core-properties+xml",
  "core-properties": "application/vnd.openxmlformats-package.core-properties+xml",
  extendedProperties: CT_BASE + "extended-properties+xml",
  "extended-properties": CT_BASE + "extended-properties+xml"
};
function expectedContentType(pkg, relType) {
  const suffix = relType.split("/").pop();
  const rule = REL_TYPE_CT[suffix];
  if (rule === void 0) return void 0;
  if (typeof rule === "string") return rule;
  const kind = pkgKind(pkg);
  return kind ? rule[kind] : void 0;
}
function contentTypeRules(pkg, out) {
  for (const [owner, map] of pkg.rels) {
    for (const rel of map.values()) {
      if (rel.mode === "External") continue;
      const expected = expectedContentType(pkg, rel.type);
      if (expected === void 0) continue;
      const target = pkg.targetOf(owner, rel.target);
      if (!pkg.parts.has(target)) continue;
      const actual = pkg.contentType(target);
      if (actual !== expected) {
        out.push(finding("wrong-content-type", target, `${target} is ${actual ?? "untyped"}, expected ${expected} for ${rel.type.split("/").pop()}`));
      }
    }
  }
}
function uniqueIds(elements, attr, part, rule, out) {
  const seen = /* @__PURE__ */ new Set();
  for (const el of elements) {
    const id = el.getAttribute(attr);
    if (id !== null && seen.has(id)) out.push(finding(rule, part, `${el.tagName} @${attr}=${id} duplicated`));
    seen.add(id);
  }
}
function pptxRules(pkg, xmlDocs, out) {
  for (const [name, doc] of xmlDocs) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
      uniqueIds(elementsOf(doc.documentElement, "p:cNvPr"), "id", name, "duplicate-shape-id", out);
    }
    if (name === "ppt/presentation.xml") {
      const lst = firstOf(doc.documentElement, "p:sldIdLst");
      const ids = [];
      for (const sld of childrenOf(lst ?? doc.documentElement, "p:sldId")) {
        const num = Number(sld.getAttribute("id"));
        ids.push(sld.getAttribute("id"));
        if (!Number.isInteger(num) || num < 256) out.push(finding("invalid-slide-id", name, `p:sldId id ${sld.getAttribute("id")} must be an integer ≥ 256`));
        const rid = sld.getAttribute("r:id");
        const rel = pkg.relsOf(name).get(rid);
        if (!rel) {
          out.push(finding("unknown-rel-ref", name, `p:sldId r:id="${rid}" has no relationship`));
          continue;
        }
        const target = pkg.targetOf(name, rel.target);
        if (!/^ppt\/slides\/slide\d+\.xml$/.test(target)) out.push(finding("sldid-not-slide", name, `p:sldId ${rid} → ${target}, not a slide part`));
      }
      const seen = /* @__PURE__ */ new Set();
      for (const id of ids) {
        if (seen.has(id)) out.push(finding("duplicate-slide-id", name, `p:sldId id ${id} used twice`));
        seen.add(id);
      }
    }
  }
}
function docxRules(pkg, xmlDocs, out) {
  const main2 = "word/document.xml";
  for (const [name, doc] of xmlDocs) {
    if (name !== main2 && !/^word\/(header|footer)\d+\.xml$|^word\/(footnotes|endnotes|comments)\.xml$/.test(name)) continue;
    uniqueIds(elementsOf(doc.documentElement, "wp:docPr"), "id", name, "duplicate-docpr-id", out);
    const paraIds = elementsOf(doc.documentElement, "w:p").map((p) => p.getAttribute("w14:paraId")).filter(Boolean);
    uniqueIds(paraIds.map((id) => ({ getAttribute: () => id, tagName: "w:p" })), null, name, "duplicate-paraid", out);
    for (const p of elementsOf(doc.documentElement, "w:p")) {
      const id = p.getAttribute("w14:paraId");
      if (id && parseInt(id, 16) >= 2147483648) out.push(finding("invalid-paraid", name, `w14:paraId ${id} ≥ 0x80000000`));
    }
    for (const tag of ["w:t", "w:delText", "w:instrText"]) {
      for (const el of elementsOf(doc.documentElement, tag)) {
        const text = el.textContent;
        if (text !== text.trim() && el.getAttribute("xml:space") !== "preserve") {
          out.push(finding("missing-xml-space", name, `${tag} "${text.slice(0, 30).trim()}…" needs xml:space="preserve"`));
        }
      }
    }
    if (name === main2) {
      const comments = xmlDocs.get("word/comments.xml");
      const ids = new Set(comments ? elementsOf(comments.documentElement, "w:comment").map((c) => c.getAttribute("w:id")) : []);
      const refs = elementsOf(doc.documentElement, "w:commentReference").concat(elementsOf(doc.documentElement, "w:commentRangeStart"), elementsOf(doc.documentElement, "w:commentRangeEnd"));
      for (const ref of refs) {
        const id = ref.getAttribute("w:id");
        if (!ids.has(id)) out.push(finding("dangling-comment", name, `${ref.tagName} w:id="${id}" has no w:comment`));
      }
    }
  }
}
function fixPackage(pkg) {
  const fixed = [];
  for (const name of pkg.parts.keys()) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    let doc, dirty = false;
    try {
      doc = parseXml(pkg.get(name));
    } catch {
      continue;
    }
    for (const tag of ["w:t", "w:delText", "w:instrText"]) {
      for (const el of elementsOf(doc.documentElement, tag)) {
        const text = el.textContent;
        if (text !== text.trim() && el.getAttribute("xml:space") !== "preserve") {
          el.setAttribute("xml:space", "preserve");
          dirty = true;
        }
      }
    }
    for (const tag of ["p:cNvPr", "wp:docPr"]) {
      const seen = /* @__PURE__ */ new Set();
      for (const el of elementsOf(doc.documentElement, tag)) {
        let id = el.getAttribute("id");
        if (id === null || seen.has(id)) {
          let next = 2;
          while (seen.has(String(next)) || hasIdAnywhere(doc, tag, String(next))) next++;
          el.setAttribute("id", String(next));
          dirty = true;
        }
        seen.add(el.getAttribute("id"));
      }
    }
    if (dirty) {
      pkg.putXml(name, doc);
      fixed.push(name);
    }
  }
  const paraIds = /* @__PURE__ */ new Set();
  for (const name of pkg.parts.keys()) {
    if (!/^word\//.test(name) || !name.endsWith(".xml")) continue;
    try {
      for (const p of elementsOf(parseXml(pkg.get(name)).documentElement, "w:p")) paraIds.add(p.getAttribute("w14:paraId"));
    } catch {
    }
  }
  for (const name of pkg.parts.keys()) {
    if (!/^word\//.test(name) || !name.endsWith(".xml")) continue;
    let doc;
    try {
      doc = parseXml(pkg.get(name));
    } catch {
      continue;
    }
    const seen = /* @__PURE__ */ new Set();
    let dirty = false;
    for (const p of elementsOf(doc.documentElement, "w:p")) {
      const id = p.getAttribute("w14:paraId");
      if (!id) continue;
      if (seen.has(id) || parseInt(id, 16) >= 2147483648) {
        let next = 1;
        while (paraIds.has(next.toString(16).padStart(8, "0")) || paraIds.has(next.toString(16))) next++;
        const fresh = next.toString(16).padStart(8, "0");
        p.setAttribute("w14:paraId", fresh);
        paraIds.add(fresh);
        dirty = true;
      }
      seen.add(p.getAttribute("w14:paraId"));
    }
    if (dirty) {
      pkg.putXml(name, doc);
      fixed.push(name);
    }
  }
  for (const [owner, map] of pkg.rels) {
    for (const rel of map.values()) {
      if (rel.mode === "External") continue;
      const expected = expectedContentType(pkg, rel.type);
      if (expected === void 0) continue;
      const target = pkg.targetOf(owner, rel.target);
      if (pkg.parts.has(target) && pkg.contentType(target) !== expected) {
        pkg.override(target, expected);
        fixed.push(target);
      }
    }
  }
  for (const part of [...pkg.overrides.keys()]) {
    if (!pkg.parts.has(part)) {
      pkg.overrides.delete(part);
      fixed.push(`-${part}`);
    }
  }
  for (const name of pkg.parts.keys()) {
    if (pkg.contentType(name) !== void 0 || name.endsWith("/")) continue;
    const type = patternType(name);
    if (type) {
      pkg.override(name, type);
      fixed.push(`+${name}`);
    }
  }
  for (const [owner, map] of pkg.rels) {
    for (const [id, rel] of [...map]) {
      if (rel.mode !== "External" && !pkg.parts.has(pkg.targetOf(owner, rel.target))) {
        map.delete(id);
        fixed.push(`${owner || "/"}#${id}`);
      }
    }
  }
  pkg.flush();
  return { fixed, remaining: checkPackage(pkg) };
}
function hasIdAnywhere(doc, tag, id) {
  for (const other of ["p:cNvPr", "wp:docPr"]) {
    if (elementsOf(doc.documentElement, other).some((el) => el.getAttribute("id") === id)) return true;
  }
  return false;
}

// src/office/docx.js
var parts = (pkg) => [...pkg.parts.keys()].filter((name) => name === "word/document.xml" || /^word\/(header|footer)\d+\.xml$/.test(name) || /^word\/(footnotes|endnotes|comments)\.xml$/.test(name));
function blockText(el, changes = false) {
  let out = "";
  const walk = (node, inside) => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      if (!inside.del) out += node.data;
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (!changes) {
      for (const child2 of [...node.childNodes]) {
        if (tag === "w:del" || tag === "w:moveFrom") continue;
        walk(child2, inside);
      }
      return;
    }
    let mark = inside;
    let pre = "", post = "";
    const author = node.getAttribute?.("w:author") ?? "";
    if (tag === "w:ins") {
      pre = `{+`;
      post = ` (${author})+}`;
      mark = { ...inside, del: false };
    } else if (tag === "w:del") {
      pre = `{-`;
      post = ` (${author})-}`;
      mark = { ...inside, del: false };
    } else if (tag === "w:moveFrom") {
      pre = `{<`;
      post = ` (${author})<}`;
      mark = { ...inside, del: false };
    } else if (tag === "w:moveTo") {
      pre = `{>`;
      post = ` (${author})>}`;
      mark = { ...inside, del: false };
    } else if (tag === "w:rPrChange" || tag === "w:pPrChange") {
      out += "{~fmt~}";
      return;
    } else if (tag === "w:moveFromRangeStart") {
      out += `{<move ${node.getAttribute("w:name") ?? ""}>`;
      return;
    } else if (tag === "w:moveToRangeStart") {
      out += `{>move ${node.getAttribute("w:name") ?? ""}>`;
      return;
    } else if (tag === "w:moveFromRangeEnd" || tag === "w:moveToRangeEnd") {
      out += "{end}";
      return;
    }
    out += pre;
    for (const child2 of [...node.childNodes]) walk(child2, mark);
    out += post;
  };
  walk(el, { del: false });
  return out;
}
function paraStyle(p) {
  return firstOf(firstOf(p, "w:pPr") ?? p, "w:pStyle")?.getAttribute("w:val");
}
function deletedParaMark(p) {
  const pPr = firstOf(p, "w:pPr");
  return pPr !== void 0 && firstOf(firstOf(pPr, "w:rPr") ?? pPr, "w:del") !== void 0;
}
function docxRead(pkg, { changes = false } = {}) {
  const doc = pkg.xml("word/document.xml");
  const body = firstOf(doc.documentElement, "w:body");
  const blocks = [];
  let pi = 0, ti = 0;
  const commentIds = commentsIndex(pkg, doc);
  for (const el of childrenOf(body)) {
    if (el.tagName === "w:p") {
      pi++;
      const id = `p${pi}`;
      const entry = { id, type: "paragraph", style: paraStyle(el), text: blockText(el, changes) };
      const anchored = commentIds.get(el);
      if (anchored) entry.comments = anchored;
      if (deletedParaMark(el)) entry.deletedParagraphMark = true;
      blocks.push(entry);
    } else if (el.tagName === "w:tbl") {
      ti++;
      blocks.push({ id: `t${ti}`, type: "table", rows: tableRows(el, changes) });
    }
  }
  const sections = [];
  const refs = elementsOf(doc.documentElement, "w:headerReference").concat(elementsOf(doc.documentElement, "w:footerReference"));
  const rels = pkg.relsOf("word/document.xml");
  for (const ref of refs) {
    const rel = rels.get(ref.getAttribute("r:id"));
    if (!rel) continue;
    const target = pkg.targetOf("word/document.xml", rel.target);
    const part = pkg.xml(target);
    sections.push({
      kind: ref.tagName === "w:headerReference" ? "header" : "footer",
      type: ref.getAttribute("w:type"),
      part: target,
      text: elementsOf(part.documentElement, "w:p").map((p) => blockText(p, changes)).filter(Boolean).join("\n")
    });
  }
  const notes = [];
  for (const [kind, part] of [["footnote", "word/footnotes.xml"], ["endnote", "word/endnotes.xml"]]) {
    if (!pkg.parts.has(part)) continue;
    for (const note of elementsOf(pkg.xml(part).documentElement, `w:${kind}`)) {
      const id = note.getAttribute("w:id");
      if (id === "-1" || id === "0") continue;
      notes.push({ kind, id, text: elementsOf(note, "w:p").map((p) => blockText(p, changes)).join(" ") });
    }
  }
  return { blocks, sections, notes, comments: commentsList(pkg, changes) };
}
function commentsIndex(pkg, doc) {
  const byEl = /* @__PURE__ */ new Map();
  if (!pkg.parts.has("word/comments.xml")) return byEl;
  for (const ref of elementsOf(doc.documentElement, "w:commentReference")) {
    let p = ref.parentNode;
    while (p && p.tagName !== "w:p") p = p.parentNode;
    if (!p) continue;
    const arr = byEl.get(p) ?? [];
    arr.push({ commentId: ref.getAttribute("w:id") });
    byEl.set(p, arr);
  }
  return byEl;
}
function commentsList(pkg, changes) {
  if (!pkg.parts.has("word/comments.xml")) return [];
  const commentsDoc = pkg.xml("word/comments.xml");
  const anchors = commentAnchors(pkg);
  return elementsOf(commentsDoc.documentElement, "w:comment").map((c) => ({
    id: c.getAttribute("w:id"),
    author: c.getAttribute("w:author"),
    initials: c.getAttribute("w:initials"),
    date: c.getAttribute("w:date"),
    text: elementsOf(c, "w:p").map((p) => blockText(p, changes)).join(" "),
    anchorsTo: anchors.get(c.getAttribute("w:id"))
  }));
}
function commentAnchors(pkg) {
  const map = /* @__PURE__ */ new Map();
  const doc = pkg.xml("word/document.xml");
  const index = blockIndex(doc);
  const byEl = new Map([...index].map(([id, el]) => [el, id]));
  for (const ref of elementsOf(doc.documentElement, "w:commentReference")) {
    let p = ref.parentNode;
    while (p && p.tagName !== "w:p") p = p.parentNode;
    if (p && byEl.has(p)) map.set(ref.getAttribute("w:id"), byEl.get(p));
  }
  return map;
}
function tableRows(tbl, changes) {
  return childrenOf(tbl, "w:tr").map((tr) => childrenOf(tr, "w:tc").map((tc) => {
    const gridSpan = firstOf(firstOf(tc, "w:tcPr") ?? tc, "w:gridSpan")?.getAttribute("w:val");
    const vMerge = firstOf(firstOf(tc, "w:tcPr") ?? tc, "w:vMerge");
    return {
      text: elementsOf(tc, "w:p").map((p) => blockText(p, changes)).join(" "),
      ...gridSpan ? { gridSpan: Number(gridSpan) } : {},
      ...vMerge ? { vMerge: vMerge.getAttribute("w:val") ?? "continue" } : {}
    };
  }));
}
function docxFields(pkg) {
  const out = [];
  for (const name of parts(pkg)) {
    const doc = pkg.xml(name);
    for (const fld of elementsOf(doc.documentElement, "w:fldSimple")) {
      out.push({ part: name, kind: "simple", instruction: fld.getAttribute("w:instr") ?? "", result: textOf(fld) });
    }
    const paras = elementsOf(doc.documentElement, "w:p");
    let open = null;
    const flush = () => {
      if (open) {
        delete open.phase;
        out.push(open);
      }
      open = null;
    };
    for (const p of paras) {
      for (const el of elementsOf(p)) {
        if (el.tagName === "w:fldChar") {
          const type = el.getAttribute("w:fldCharType");
          if (type === "begin") {
            flush();
            open = { part: name, kind: "complex", instruction: "", result: "" };
          } else if (type === "separate" && open) open.phase = "result";
          else if (type === "end") flush();
        } else if (open && el.tagName === "w:instrText" && open.phase !== "result") open.instruction += el.textContent;
        else if (open && open.phase === "result" && (el.tagName === "w:t" || el.tagName === "w:delText")) open.result += el.textContent;
      }
    }
    flush();
  }
  return out;
}
var EDIT_PARTS = (pkg, bodyOnly) => parts(pkg).filter((name) => name === "word/document.xml" || !bodyOnly && /^word\/(header|footer)\d+\.xml$|^word\/(footnotes|endnotes)\.xml$/.test(name));
function blockIndex(doc) {
  const body = firstOf(doc.documentElement, "w:body");
  const map = /* @__PURE__ */ new Map();
  let pi = 0, ti = 0;
  for (const el of childrenOf(body)) {
    if (el.tagName === "w:p") map.set(`p${++pi}`, el);
    else if (el.tagName === "w:tbl") map.set(`t${++ti}`, el);
  }
  return map;
}
function isDeleted(p, r) {
  for (let n = r; n && n !== p; n = n.parentNode) if (n.tagName === "w:del" || n.tagName === "w:moveFrom") return true;
  return false;
}
function docxEdit(pkg, ops) {
  const docs = /* @__PURE__ */ new Map();
  const getDoc = (name) => {
    if (!docs.has(name)) docs.set(name, pkg.xml(name));
    return docs.get(name);
  };
  const body = firstOf(getDoc("word/document.xml").documentElement, "w:body");
  const blocks = blockIndex(getDoc("word/document.xml"));
  const blockOf = (id) => {
    const block = blocks.get(id);
    if (!block || block.parentNode !== body) throw new Error(`no block ${id}`);
    return block;
  };
  const changed = /* @__PURE__ */ new Set();
  let count = 0;
  ops.forEach((op, index) => {
    try {
      applyOp(pkg, getDoc, blockOf, changed, op);
      count++;
    } catch (error) {
      const e = new Error(`op ${index} (${opKind(op)}): ${error.message}`);
      e.code = "ops";
      throw e;
    }
  });
  for (const [name, doc] of docs) if (changed.has(name)) pkg.putXml(name, doc);
  return { changed: [...changed], count };
}
var opKind = (op) => Object.keys(op).find((k) => !["o", "inPlace"].includes(k)) ?? "?";
function applyOp(pkg, getDoc, blockOf, changed, op) {
  const mainDoc = () => getDoc("word/document.xml");
  if (op.replace) {
    const { find, with: withText, regex = false, bodyOnly = false } = op.replace;
    const re = regex ? new RegExp(find, "g") : new RegExp(escapeRe(find), "g");
    for (const name of EDIT_PARTS(pkg, bodyOnly)) {
      const doc = getDoc(name);
      const n = replaceInDoc(doc, re, withText);
      if (n > 0) changed.add(name);
    }
    return;
  }
  if (op.set_cell) {
    const { table, row, col, text } = op.set_cell;
    const tbl = blockOf(`t${table}`);
    const tr = childrenOf(tbl, "w:tr")[row - 1];
    const tc = tr && childrenOf(tr, "w:tc")[col - 1];
    if (!tc) throw new Error(`no cell r${row}c${col} in t${table}`);
    setCellText(getDoc("word/document.xml"), tc, String(text));
    changed.add("word/document.xml");
    return;
  }
  if (op.set_field) {
    const { match, value } = op.set_field;
    const re = new RegExp(match);
    let any = false;
    for (const name of EDIT_PARTS(pkg, false)) {
      const doc = getDoc(name);
      let hit = false;
      for (const fld of elementsOf(doc.documentElement, "w:fldSimple")) {
        if (re.test(fld.getAttribute("w:instr") ?? "")) {
          setFieldResult(doc, fld, String(value));
          hit = true;
        }
      }
      if (setComplexFieldResult(doc, re, String(value))) hit = true;
      if (hit) {
        changed.add(name);
        any = true;
      }
    }
    if (!any) throw new Error(`no field instruction matches /${match}/`);
    return;
  }
  if (op.insert) {
    const { after, before, text, style, like } = op.insert;
    const doc = mainDoc();
    const anchor = blockOf(after ?? before);
    const p = doc.createElement("w:p");
    if (style || like) {
      const pPr = doc.createElement("w:pPr");
      const pStyle = doc.createElement("w:pStyle");
      pStyle.setAttribute("w:val", style ?? paraStyle(blockOf(like)) ?? "Normal");
      pPr.appendChild(pStyle);
      p.appendChild(pPr);
    }
    const r = doc.createElement("w:r");
    const t = doc.createElement("w:t");
    t.setAttribute("xml:space", "preserve");
    t.appendChild(doc.createTextNode(text));
    r.appendChild(t);
    p.appendChild(r);
    anchor.parentNode.insertBefore(p, before ? anchor : anchor.nextSibling);
    changed.add("word/document.xml");
    return;
  }
  if (op.delete) {
    for (const id of op.delete.paragraphs) {
      const el = blockOf(id);
      el.parentNode.removeChild(el);
    }
    changed.add("word/document.xml");
    return;
  }
  if (op.comment) {
    addComment(pkg, getDoc, blockOf, changed, op.comment);
    return;
  }
  if (op.accept_changes || op.reject_changes) {
    const accept = Boolean(op.accept_changes);
    for (const name of parts(pkg)) {
      if (!pkg.parts.has(name)) continue;
      const doc = getDoc(name);
      if (resolveChanges(doc, accept)) changed.add(name);
    }
    return;
  }
  throw new Error(`unknown op ${JSON.stringify(op)}`);
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var expand = (m, withText) => withText.replace(/\$(\$|&|[1-9]\d?)/g, (_, g) => g === "$" ? "$" : g === "&" ? m[0] : m[Number(g)] ?? "");
var nearestPara = (el) => {
  for (let n = el.parentNode; n; n = n.parentNode) if (n.tagName === "w:p") return n;
  return null;
};
var cloneRun = (doc, src, text) => {
  const clone = src.cloneNode(false);
  const rPr = childrenOf(src, "w:rPr")[0];
  if (rPr) clone.appendChild(rPr.cloneNode(true));
  const t = doc.createElement("w:t");
  t.setAttribute("xml:space", "preserve");
  t.appendChild(doc.createTextNode(text));
  clone.appendChild(t);
  return clone;
};
function replaceInDoc(doc, re, withText) {
  let total = 0;
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const p of elementsOf(doc.documentElement, "w:p")) {
    const runs = elementsOf(p, "w:r").filter((r) => !isDeleted(p, r) && nearestPara(r) === p);
    const texts = runs.map((r) => elementsOf(r, "w:t").map((t) => t.textContent).join(""));
    const joined = texts.join("");
    const matches = [...joined.matchAll(global)];
    if (matches.length === 0) continue;
    if (runs.length === 0) {
      const run = doc.createElement("w:r");
      run.appendChild(doc.createElement("w:t"));
      p.appendChild(run);
      runs.push(run);
      texts.push("");
    }
    const bounds = [];
    let cursor = 0;
    for (const t of texts) {
      bounds.push([cursor, cursor + t.length]);
      cursor += t.length;
    }
    for (let i = 0; i < runs.length; i++) {
      const [rs, rend] = bounds[i];
      const startsHere = (m) => m.index >= rs && (m.index < rend || i === runs.length - 1 && m.index === rend);
      const covers = matches.filter((m) => startsHere(m) || m.index < rend && m.index + m[0].length > rs);
      if (covers.length === 0) continue;
      const pieces = [];
      let pos = 0;
      for (const m of covers) {
        const cs = Math.max(0, m.index - rs);
        const ce = Math.min(texts[i].length, m.index + m[0].length - rs);
        if (cs > pos) pieces.push({ text: texts[i].slice(pos, cs) });
        if (startsHere(m)) pieces.push({ repl: expand(m, withText) });
        pos = ce;
      }
      if (pos < texts[i].length || pieces.length === 0) pieces.push({ text: texts[i].slice(pos) });
      const run = runs[i];
      let anchor = run;
      for (const [k, piece] of pieces.entries()) {
        if (k === 0) {
          setRunText(run, piece.text ?? "");
          if (piece.text !== void 0) continue;
        }
        const clone = cloneRun(doc, run, piece.repl ?? piece.text);
        anchor.parentNode.insertBefore(clone, anchor.nextSibling);
        anchor = clone;
      }
      total += covers.filter(startsHere).length;
    }
  }
  return total;
}
function setRunText(run, text) {
  const ts = elementsOf(run, "w:t");
  if (ts.length === 0) return;
  ts[0].textContent = text;
  if (text !== text.trim()) ts[0].setAttribute("xml:space", "preserve");
  for (const extra of ts.slice(1)) extra.textContent = "";
}
function setCellText(doc, tc, text) {
  const paras = childrenOf(tc, "w:p");
  const pPr = paras[0] && childrenOf(paras[0], "w:pPr")[0];
  const firstRun = paras[0] && elementsOf(paras[0], "w:r")[0];
  const rPr = firstRun && childrenOf(firstRun, "w:rPr")[0];
  for (const p2 of paras) tc.removeChild(p2);
  const p = doc.createElement("w:p");
  if (pPr) p.appendChild(pPr);
  const r = doc.createElement("w:r");
  if (rPr) r.appendChild(rPr);
  const t = doc.createElement("w:t");
  t.setAttribute("xml:space", "preserve");
  t.appendChild(doc.createTextNode(text));
  r.appendChild(t);
  p.appendChild(r);
  tc.appendChild(p);
}
function setFieldResult(doc, fld, value) {
  const rPr = elementsOf(fld, "w:r")[0] && childrenOf(elementsOf(fld, "w:r")[0], "w:rPr")[0];
  for (const child2 of [...fld.childNodes]) fld.removeChild(child2);
  const r = doc.createElement("w:r");
  if (rPr) r.appendChild(rPr.cloneNode(true));
  const t = doc.createElement("w:t");
  t.setAttribute("xml:space", "preserve");
  t.appendChild(doc.createTextNode(value));
  r.appendChild(t);
  fld.appendChild(r);
}
function setComplexFieldResult(doc, re, value) {
  let hit = false;
  let depth = 0, inField = false, inResult = false, first = true;
  for (const el of elementsOf(doc.documentElement)) {
    if (el.tagName === "w:instrText") {
      if (!inField && re.test(el.textContent)) {
        inField = true;
        depth = 1;
        inResult = false;
        first = true;
      }
      continue;
    }
    if (!inField) continue;
    if (el.tagName === "w:fldChar") {
      const type = el.getAttribute("w:fldCharType");
      if (type === "begin") depth++;
      else if (type === "end") {
        depth--;
        if (depth === 0) inField = false;
      } else if (type === "separate" && depth === 1) inResult = true;
      continue;
    }
    if (inResult && el.tagName === "w:r") {
      if (first) {
        setRunText(el, value);
        first = false;
      } else setRunText(el, "");
      hit = true;
    }
  }
  return hit;
}
var ancestor = (node, tag) => {
  for (let n = node.parentNode; n; n = n.parentNode) if (n.tagName === tag) return n;
  return null;
};
function splitRunAt(doc, run, offset) {
  const text = elementsOf(run, "w:t").map((t) => t.textContent).join("");
  const clone = cloneRun(doc, run, text.slice(offset));
  setRunText(run, text.slice(0, offset));
  run.parentNode.insertBefore(clone, run.nextSibling);
  return clone;
}
function phraseRuns(doc, p, anchor) {
  const runs = elementsOf(p, "w:r").filter((r) => !isDeleted(p, r) && nearestPara(r) === p);
  const texts = runs.map((r) => elementsOf(r, "w:t").map((t) => t.textContent).join(""));
  const joined = texts.join("");
  const start = joined.indexOf(anchor);
  if (start < 0) return void 0;
  const end = start + anchor.length;
  const locate = (pos) => {
    let c = 0;
    for (let i = 0; i < runs.length; i++) {
      const e2 = c + texts[i].length;
      if (pos < e2 || pos === e2 && i === runs.length - 1) return { i, off: pos - c };
      c = e2;
    }
    return { i: runs.length - 1, off: texts.at(-1).length };
  };
  const e = locate(end), s = locate(start);
  let lastRun, firstRun;
  if (e.off === texts[e.i].length) lastRun = runs[e.i];
  else if (e.off === 0) lastRun = runs[e.i - 1];
  else {
    splitRunAt(doc, runs[e.i], e.off);
    lastRun = runs[e.i];
  }
  if (s.i === e.i && s.off > 0) {
    firstRun = lastRun = splitRunAt(doc, runs[s.i], s.off);
  } else {
    firstRun = s.off === 0 ? runs[s.i] : splitRunAt(doc, runs[s.i], s.off);
  }
  return { firstRun, lastRun };
}
function addComment(pkg, getDoc, blockOf, changed, { paragraph, text, anchor, author = "Bot", initials = "B" }) {
  const doc = getDoc("word/document.xml");
  const p = blockOf(paragraph);
  let commentsDoc;
  if (!pkg.parts.has("word/comments.xml")) {
    commentsDoc = parseXml('<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>');
    pkg.rels.set("word/document.xml", pkg.relsOf("word/document.xml"));
    let next = 1;
    const map = pkg.rels.get("word/document.xml");
    while (map.has(`rId${next}`)) next++;
    map.set(`rId${next}`, { id: `rId${next}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments", target: "comments.xml", mode: "Internal" });
    pkg.override("word/comments.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml");
  } else commentsDoc = getDoc("word/comments.xml");
  const id = String(Math.max(0, ...elementsOf(commentsDoc.documentElement, "w:comment").map((c) => Number(c.getAttribute("w:id")) || 0)) + 1);
  const comment = commentsDoc.createElement("w:comment");
  comment.setAttribute("w:id", id);
  comment.setAttribute("w:author", author);
  comment.setAttribute("w:initials", initials);
  const cp = commentsDoc.createElement("w:p");
  const cr = commentsDoc.createElement("w:r");
  const ct = commentsDoc.createElement("w:t");
  ct.setAttribute("xml:space", "preserve");
  ct.appendChild(commentsDoc.createTextNode(text));
  cr.appendChild(ct);
  cp.appendChild(cr);
  comment.appendChild(cp);
  commentsDoc.documentElement.appendChild(comment);
  pkg.putXml("word/comments.xml", commentsDoc);
  const rangeStart = doc.createElement("w:commentRangeStart");
  rangeStart.setAttribute("w:id", id);
  const rangeEnd = doc.createElement("w:commentRangeEnd");
  rangeEnd.setAttribute("w:id", id);
  const ref = doc.createElement("w:r");
  const refEl = doc.createElement("w:commentReference");
  refEl.setAttribute("w:id", id);
  ref.appendChild(refEl);
  const pPr = childrenOf(p, "w:pPr")[0];
  if (anchor) {
    const span = phraseRuns(doc, p, anchor);
    if (!span) throw new Error(`anchor "${anchor}" not found in ${paragraph}`);
    span.firstRun.parentNode.insertBefore(rangeStart, span.firstRun);
    span.lastRun.parentNode.insertBefore(rangeEnd, span.lastRun.nextSibling);
    span.lastRun.parentNode.insertBefore(ref, rangeEnd.nextSibling);
  } else {
    p.insertBefore(rangeStart, pPr ? pPr.nextSibling : p.firstChild);
    p.appendChild(rangeEnd);
    p.appendChild(ref);
  }
  changed.add("word/document.xml");
}
function resolveChanges(doc, accept) {
  let dirty = false;
  const lift = (el) => {
    while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
    el.parentNode.removeChild(el);
  };
  const mergeIntoNext = (p, pPr) => {
    const next = p.nextSibling;
    if (!next || next.tagName !== "w:p") return false;
    const nextPPr = childrenOf(next, "w:pPr")[0];
    const anchor = nextPPr ? nextPPr.nextSibling : next.firstChild;
    for (const node of [...p.childNodes]) {
      if (node === pPr) continue;
      next.insertBefore(node, anchor);
    }
    p.parentNode.removeChild(p);
    return true;
  };
  for (const p of elementsOf(doc.documentElement, "w:p")) {
    const pPr = childrenOf(p, "w:pPr")[0];
    const rPr = pPr && childrenOf(pPr, "w:rPr")[0];
    if (!rPr) continue;
    const del = childrenOf(rPr, "w:del")[0];
    const ins = childrenOf(rPr, "w:ins")[0];
    if (del) {
      dirty = true;
      if (!accept || !mergeIntoNext(p, pPr)) rPr.removeChild(del);
    } else if (ins) {
      dirty = true;
      if (accept || !mergeIntoNext(p, pPr)) rPr.removeChild(ins);
    }
  }
  for (const tr of elementsOf(doc.documentElement, "w:tr")) {
    const trPr = childrenOf(tr, "w:trPr")[0];
    if (!trPr) continue;
    const ins = childrenOf(trPr, "w:ins")[0];
    const del = childrenOf(trPr, "w:del")[0];
    if (ins) {
      dirty = true;
      if (accept) trPr.removeChild(ins);
      else tr.parentNode.removeChild(tr);
    } else if (del) {
      dirty = true;
      if (accept) tr.parentNode.removeChild(tr);
      else trPr.removeChild(del);
    }
  }
  for (const el of elementsOf(doc.documentElement)) {
    const tag = el.tagName;
    if (tag === "w:moveFromRangeStart" || tag === "w:moveFromRangeEnd" || tag === "w:moveToRangeStart" || tag === "w:moveToRangeEnd" || tag === "w:customXmlInsRangeStart" || tag === "w:customXmlInsRangeEnd" || tag === "w:customXmlDelRangeStart" || tag === "w:customXmlDelRangeEnd" || tag === "w:customXmlMoveFromRangeStart" || tag === "w:customXmlMoveFromRangeEnd" || tag === "w:customXmlMoveToRangeStart" || tag === "w:customXmlMoveToRangeEnd") {
      el.parentNode?.removeChild(el);
      dirty = true;
    }
  }
  for (const el of elementsOf(doc.documentElement)) {
    const tag = el.tagName;
    if (tag === "w:ins" || tag === "w:moveTo") {
      if (accept) lift(el);
      else el.parentNode.removeChild(el);
      dirty = true;
    } else if (tag === "w:del" || tag === "w:moveFrom") {
      if (accept) {
        el.parentNode.removeChild(el);
        dirty = true;
      } else {
        for (const t of elementsOf(el, "w:delText")) {
          t.tagName = "w:t";
        }
        lift(el);
        dirty = true;
      }
    } else if (tag === "w:numberingChange") {
      el.parentNode.removeChild(el);
      dirty = true;
    } else if (/^w:(pPrChange|rPrChange|tblPrChange|tcPrChange|trPrChange|sectPrChange)$/.test(tag)) {
      const parent = el.parentNode;
      if (accept) {
        parent.removeChild(el);
        dirty = true;
      } else {
        const stored = childrenOf(el)[0];
        const keep = /* @__PURE__ */ new Set();
        if (parent.tagName === "w:pPr") {
          keep.add("w:rPr");
          keep.add("w:sectPr");
        }
        if (parent.tagName === "w:sectPr") {
          keep.add("w:headerReference");
          keep.add("w:footerReference");
        }
        for (const c of [...parent.childNodes]) if (!keep.has(c.tagName) && c !== el) parent.removeChild(c);
        if (stored) {
          const kept = [...parent.childNodes].filter((c) => keep.has(c.tagName));
          const anchor = parent.tagName === "w:sectPr" ? kept.length > 0 ? kept.at(-1).nextSibling : parent.firstChild === el ? null : parent.firstChild : kept[0] ?? el;
          for (const s of [...stored.childNodes]) parent.insertBefore(s, anchor);
        }
        parent.removeChild(el);
        dirty = true;
      }
    } else if (tag === "w:cellIns" || tag === "w:cellDel") {
      const tc = ancestor(el, "w:tc");
      if (tc) {
        if (accept && tag === "w:cellDel") tc.parentNode?.removeChild(tc);
        else if (!accept && tag === "w:cellIns") tc.parentNode?.removeChild(tc);
        el.parentNode.removeChild(el);
        dirty = true;
      }
    }
  }
  return dirty;
}

// src/office/pptx.js
import { posix as posix3 } from "node:path";
var EMU = 914400;
var SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/;
var slideParts = (pkg) => [...pkg.parts.keys()].filter((n) => SLIDE_RE.test(n));
var deckOrder = (pkg) => {
  const pres = pkg.xml("ppt/presentation.xml");
  const lst = firstOf(pres.documentElement, "p:sldIdLst");
  const rels = pkg.relsOf("ppt/presentation.xml");
  return childrenOf(lst ?? pres.documentElement, "p:sldId").map((s) => {
    const rel = rels.get(s.getAttribute("r:id"));
    return { sldId: s.getAttribute("id"), rid: s.getAttribute("r:id"), part: rel && pkg.targetOf("ppt/presentation.xml", rel.target) };
  }).filter((e) => e.part);
};
var slideSize = (pkg) => {
  const sz = firstOf(pkg.xml("ppt/presentation.xml").documentElement, "p:sldSz");
  return { cx: Number(sz?.getAttribute("cx") ?? 0) / EMU, cy: Number(sz?.getAttribute("cy") ?? 0) / EMU };
};
var themeFonts = (pkg) => {
  const theme = [...pkg.parts.keys()].find((n) => /^ppt\/theme\/theme\d+\.xml$/.test(n));
  if (!theme) return {};
  const doc = pkg.xml(theme);
  const get = (tag) => elementsOf(doc.documentElement, tag).map((e) => firstOf(e, "a:latin")?.getAttribute("typeface")).find(Boolean);
  return { major: get("a:majorFont"), minor: get("a:minorFont") };
};
function relTarget(pkg, owner, el, attr = "r:id") {
  const rel = pkg.relsOf(owner).get(el?.getAttribute(attr));
  return rel && pkg.targetOf(owner, rel.target);
}
var relatedPart = (pkg, owner, tags) => {
  for (const rel of pkg.relList(owner)) if (tags.some((t) => rel.type.endsWith(`/${t}`))) return pkg.targetOf(owner, rel.target);
  return void 0;
};
var child = (el, tag) => childrenOf(el, tag)[0];
var nvPrOf = (sp) => child(child(sp, "p:nvSpPr") ?? child(sp, "p:nvPicPr") ?? child(sp, "p:nvGrpSpPr") ?? child(sp, "p:nvCxnSpPr") ?? child(sp, "p:nvGraphicFramePr") ?? sp, "p:nvPr");
function phOf(sp) {
  const ph = child(nvPrOf(sp) ?? sp, "p:ph");
  return ph ? { type: ph.getAttribute("type") ?? "body", idx: ph.getAttribute("idx") } : void 0;
}
var shapeName = (sp) => child(child(sp, "p:nvSpPr") ?? child(sp, "p:nvPicPr") ?? child(sp, "p:nvGrpSpPr") ?? child(sp, "p:nvCxnSpPr") ?? child(sp, "p:nvGraphicFramePr") ?? sp, "p:cNvPr")?.getAttribute("name");
var shapeId = (sp) => child(child(sp, "p:nvSpPr") ?? child(sp, "p:nvPicPr") ?? child(sp, "p:nvGrpSpPr") ?? child(sp, "p:nvCxnSpPr") ?? child(sp, "p:nvGraphicFramePr") ?? sp, "p:cNvPr")?.getAttribute("id");
var xfrmOf = (sp) => child(child(sp, "p:spPr") ?? sp, "a:xfrm");
var off = (xfrm) => ({ x: Number(firstOf(xfrm, "a:off")?.getAttribute("x") ?? 0), y: Number(firstOf(xfrm, "a:off")?.getAttribute("y") ?? 0) });
var ext = (xfrm) => ({ cx: Number(firstOf(xfrm, "a:ext")?.getAttribute("cx") ?? 0), cy: Number(firstOf(xfrm, "a:ext")?.getAttribute("cy") ?? 0) });
function applyGroup(box, grpSp) {
  const g = child(child(grpSp, "p:grpSpPr") ?? grpSp, "a:xfrm");
  if (!g) return box;
  const o = off(g), e = ext(g);
  const co = firstOf(g, "a:chOff"), ce = firstOf(g, "a:chExt");
  const sx = e.cx / Number(ce?.getAttribute("cx") || e.cx || 1);
  const sy = e.cy / Number(ce?.getAttribute("cy") || e.cy || 1);
  const cx0 = Number(co?.getAttribute("x") ?? 0), cy0 = Number(co?.getAttribute("y") ?? 0);
  return { x: o.x + (box.x - cx0) * sx, y: o.y + (box.y - cy0) * sy, cx: box.cx * sx, cy: box.cy * sy };
}
function shapeBox(pkg, sp, layoutDoc, masterDoc, groupChain = []) {
  const xfrm = xfrmOf(sp);
  let box;
  if (xfrm && (firstOf(xfrm, "a:off") || firstOf(xfrm, "a:ext"))) {
    const o = off(xfrm), e = ext(xfrm);
    box = { x: o.x, y: o.y, cx: e.cx, cy: e.cy };
  } else {
    const ph = phOf(sp);
    box = void 0;
    if (ph) {
      for (const doc of [layoutDoc, masterDoc]) {
        if (!doc) continue;
        const match = elementsOf(doc.documentElement).find((c) => (c.tagName === "p:sp" || c.tagName === "p:pic") && phMatch(phOf(c), ph));
        const inh = match && xfrmOf(match);
        if (inh) {
          box = { ...off(inh), ...ext(inh) };
          box = { x: box.x, y: box.y, cx: box.cx, cy: box.cy };
          break;
        }
      }
    }
    if (!box) return void 0;
  }
  for (const grp of groupChain) box = applyGroup(box, grp);
  return box;
}
var phMatch = (a, b) => a && b && a.type === b.type && String(a.idx ?? "") === String(b.idx ?? "");
var inches = (box) => ({ x: +(box.x / EMU).toFixed(2), y: +(box.y / EMU).toFixed(2), w: +(box.cx / EMU).toFixed(2), h: +(box.cy / EMU).toFixed(2) });
var KIND = { "p:sp": "text", "p:pic": "picture", "p:graphicFrame": "frame", "p:grpSp": "group", "p:cxnSp": "connector" };
function shapeKind(sp) {
  if (sp.tagName === "p:graphicFrame") {
    const data = firstOf(firstOf(sp, "a:graphic") ?? sp, "a:graphicData");
    const uri = data?.getAttribute("uri") ?? "";
    return uri.includes("chart") ? "chart" : uri.includes("table") ? "table" : "frame";
  }
  if (sp.tagName === "p:sp" && textOf(sp).trim() === "") return "shape";
  return KIND[sp.tagName] ?? sp.tagName;
}
function shapeText(sp) {
  const body = child(sp, "p:txBody");
  if (!body) return [];
  return childrenOf(body, "a:p").map((p) => ({
    text: textOf(p),
    runs: elementsOf(p, "a:r").map((r) => ({
      text: textOf(r),
      font: firstOf(firstOf(r, "a:rPr") ?? r, "a:latin")?.getAttribute("typeface"),
      size: Number(firstOf(r, "a:rPr")?.getAttribute("sz") ?? 0) / 100 || void 0
    }))
  })).filter((p) => p.text !== "" || p.runs.length > 0);
}
function shapesIn(spTree, pkg, layoutDoc, masterDoc, groupChain = []) {
  const out = [];
  for (const el of childrenOf(spTree)) {
    if (!KIND[el.tagName]) continue;
    if (el.tagName === "p:grpSp") {
      out.push(describe(el, pkg, layoutDoc, masterDoc, groupChain));
      out.push(...shapesIn(el, pkg, layoutDoc, masterDoc, [...groupChain, el]).map((s) => ({ ...s, inGroup: shapeName(el) })));
      continue;
    }
    out.push(describe(el, pkg, layoutDoc, masterDoc, groupChain));
  }
  return out;
}
function describe(sp, pkg, layoutDoc, masterDoc, groupChain) {
  const entry = { id: shapeId(sp), name: shapeName(sp), kind: shapeKind(sp) };
  const ph = phOf(sp);
  if (ph) entry.placeholder = ph;
  const box = shapeBox(pkg, sp, layoutDoc, masterDoc, groupChain);
  if (box) entry.box = inches(box);
  if (sp.tagName === "p:pic") {
    const blip = elementsOf(sp, "a:blip")[0];
    const media = blip && relTarget(pkg, entry.owner ?? sp.ownerDocument?.partName, blip, "r:embed");
    if (media) entry.media = media;
  }
  const paragraphs = shapeText(sp);
  if (paragraphs.length > 0) entry.text = paragraphs;
  return entry;
}
var layoutName = (doc) => firstOf(doc.documentElement, "p:cSld")?.getAttribute("name");
var notesText = (pkg, slide) => {
  const notes = relatedPart(pkg, slide, ["notesSlide"]);
  if (!notes || !pkg.parts.has(notes)) return "";
  return elementsOf(pkg.xml(notes).documentElement, "p:sp").map((s) => textOf(s).trim()).filter((t) => t && !/^(slide number|\d+)$/i.test(t)).join(" ");
};
function pptxInventory(pkg, slidesFilter) {
  const size = slideSize(pkg);
  const fonts = themeFonts(pkg);
  const order = deckOrder(pkg);
  const wanted = new Set(slidesFilter?.length ? slidesFilter.map(String) : order.map((_, i) => String(i + 1)));
  const slides = order.map((entry, i) => {
    const pos = i + 1;
    if (!wanted.has(String(pos)) && !wanted.has(entry.part)) return void 0;
    if (!pkg.parts.has(entry.part)) return { position: pos, part: entry.part, missing: true };
    const doc = pkg.xml(entry.part);
    doc.partName = entry.part;
    const layoutPart = relatedPart(pkg, entry.part, ["slideLayout"]);
    const masterPart = layoutPart && relatedPart(pkg, layoutPart, ["slideMaster"]);
    const layoutDoc = layoutPart && pkg.parts.has(layoutPart) ? pkg.xml(layoutPart) : void 0;
    const masterDoc = masterPart && pkg.parts.has(masterPart) ? pkg.xml(masterPart) : void 0;
    const tree = firstOf(firstOf(doc.documentElement, "p:cSld") ?? doc.documentElement, "p:spTree");
    const shapes = tree ? shapesIn(tree, pkg, layoutDoc, masterDoc) : [];
    for (const s of shapes) s.owner = void 0;
    return {
      position: pos,
      part: entry.part,
      sldId: entry.sldId,
      layout: layoutPart ? layoutName(pkg.xml(layoutPart)) : void 0,
      hidden: doc.documentElement.getAttribute("show") === "0" || void 0,
      notes: notesText(pkg, entry.part) || void 0,
      shapes
    };
  }).filter(Boolean);
  return { slideSize: size, themeFonts: fonts, slides };
}
function pptxLayout(pkg, slidesFilter, { autofit = false } = {}) {
  const inv = pptxInventory(pkg, slidesFilter);
  const size = inv.slideSize;
  const findings = [];
  const fitted = [];
  for (const slide of inv.slides) {
    if (!slide.shapes) continue;
    const allBoxes = [];
    const collect = (shapes) => {
      for (const s of shapes) {
        if (s.box) allBoxes.push(s);
        if (s.children) collect(s.children);
      }
    };
    collect(slide.shapes);
    const boxes = slide.shapes.filter((s) => s.box && s.text?.length);
    for (const s of allBoxes) {
      const a = s.box;
      if (a.x < 0 || a.y < 0 || a.x + a.w > size.cx + 0.01 || a.y + a.h > size.cy + 0.01) {
        findings.push({ slide: slide.position, rule: "off-slide", shape: s.name, box: a });
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box, b = boxes[j].box;
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const area = ox * oy;
        if (area <= 0) continue;
        const share = area / Math.min(a.w * a.h, b.w * b.h);
        findings.push({ slide: slide.position, rule: "overlap", shapes: [boxes[i].name, boxes[j].name], area: +area.toFixed(2), shareOfSmaller: +share.toFixed(2) });
      }
    }
    if (autofit) {
      const names = new Set(findings.filter((f) => f.slide === slide.position).flatMap((f) => f.shapes ?? [f.shape]));
      if (names.size > 0) {
        const doc = pkg.xml(slide.part);
        for (const el of elementsOf(doc.documentElement, "p:sp")) {
          if (!names.has(shapeName(el))) continue;
          const body = firstOf(el, "p:txBody");
          const bodyPr = body && firstOf(body, "a:bodyPr");
          if (bodyPr && !firstOf(bodyPr, "a:normAutofit")) {
            for (const tag of ["a:noAutofit", "a:spAutoFit"]) {
              const old = firstOf(bodyPr, tag);
              if (old) bodyPr.removeChild(old);
            }
            const anchor = childrenOf(bodyPr).find((c) => ["a:scene3d", "a:sp3d", "a:flatTx", "a:extLst"].includes(c.tagName));
            bodyPr.insertBefore(doc.createElement("a:normAutofit"), anchor ?? null);
            fitted.push(`${slide.position}:${shapeName(el)}`);
          }
        }
        pkg.putXml(slide.part, doc);
      }
    }
  }
  return { findings, autofitApplied: fitted, note: "Text overflowing inside a box still needs a render to see." };
}
function pptxSlides(pkg, order) {
  const current = deckOrder(pkg);
  const pres = pkg.xml("ppt/presentation.xml");
  const lst = firstOf(pres.documentElement, "p:sldIdLst");
  const presRels = pkg.rels.get("ppt/presentation.xml");
  const usedSldIds = new Set(current.map((e) => Number(e.sldId)));
  const newSlidePart = () => {
    let n = 1;
    while (pkg.parts.has(`ppt/slides/slide${n}.xml`)) n++;
    return n;
  };
  const newSldId = () => {
    let n = Math.max(256, ...usedSldIds) + 1;
    usedSldIds.add(n);
    return n;
  };
  const seen = /* @__PURE__ */ new Set();
  const newEntries = [];
  const duplicated = [];
  for (const pos of order) {
    const source = current[pos - 1];
    if (!source) throw new Error(`no slide at position ${pos}`);
    if (!seen.has(pos)) {
      newEntries.push({ ...source });
      seen.add(pos);
      continue;
    }
    const dup = String(newSlidePart());
    const newPart = `ppt/slides/slide${dup}.xml`;
    pkg.parts.set(newPart, { data: pkg.get(source.part) });
    if (pkg.overrides.has(source.part)) pkg.overrides.set(newPart, pkg.overrides.get(source.part));
    const mapped = /* @__PURE__ */ new Map([[source.part, newPart]]);
    const rid = `rId${nextRid(presRels)}`;
    presRels.set(rid, { id: rid, type: presRels.get(source.rid)?.type ?? "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide", target: `slides/slide${dup}.xml`, mode: "Internal" });
    const sid = String(newSldId());
    const slideRels = /* @__PURE__ */ new Map();
    for (const [id, rel] of pkg.relsOf(source.part)) {
      if (rel.mode === "External") {
        slideRels.set(id, { ...rel });
        continue;
      }
      const target = pkg.targetOf(source.part, rel.target);
      if (/notesSlide|chart|package|oleObject|embeddings/i.test(rel.type) && pkg.parts.has(target)) {
        const newTarget = copyPart(pkg, target, mapped);
        slideRels.set(id, { ...rel, target: posix3.relative(posix3.dirname(newPart), newTarget) });
      } else slideRels.set(id, { ...rel });
    }
    pkg.rels.set(newPart, slideRels);
    for (const copy of mapped.values()) {
      const map = pkg.rels.get(copy);
      if (!map) continue;
      for (const rel of map.values()) {
        if (rel.mode === "External") continue;
        const abs = pkg.targetOf(copy, rel.target);
        if (mapped.has(abs)) rel.target = posix3.relative(posix3.dirname(copy), mapped.get(abs));
      }
    }
    newEntries.push({ sldId: sid, rid, part: newPart });
    duplicated.push(pos);
  }
  for (const el of childrenOf(lst)) lst.removeChild(el);
  for (const entry of newEntries) {
    const el = pres.createElement("p:sldId");
    el.setAttribute("id", entry.sldId);
    el.setAttribute("r:id", entry.rid);
    lst.appendChild(el);
  }
  for (const [rid, rel] of [...presRels]) {
    if (rel.type.endsWith("/slide") && !newEntries.some((e) => e.rid === rid)) presRels.delete(rid);
  }
  const kept = new Set(newEntries.map((e) => e.part));
  const removed = current.filter((e) => !kept.has(e.part)).map((e) => e.part);
  for (const part of removed) pkg.remove(part);
  pkg.putXml("ppt/presentation.xml", pres);
  const cleaned = pptxClean(pkg);
  return { order, duplicated, removed: [...removed, ...cleaned.removed] };
}
var maxNum = (names, re) => Math.max(0, ...names.map((n) => Number(re.exec(n)?.[1] ?? 0)));
var nextRid = (map) => {
  let i = 1;
  while (map.has(`rId${i}`)) i++;
  return i;
};
function copyPart(pkg, part, mapped = /* @__PURE__ */ new Map()) {
  const dir = posix3.dirname(part), base = posix3.basename(part);
  const stem = base.replace(/\d+(\.\w+)$/, ""), extn = base.match(/\.\w+$/)[0];
  const n = maxNum([...pkg.parts.keys()].filter((k) => k.startsWith(dir + "/")), new RegExp(`${stem}(\\d+)${extn.replace(".", "\\.")}$`)) + 1;
  const target = `${dir}/${stem}${n}${extn}`;
  pkg.parts.set(target, { data: pkg.get(part) });
  mapped.set(part, target);
  if (pkg.overrides.has(part)) pkg.overrides.set(target, pkg.overrides.get(part));
  const map = /* @__PURE__ */ new Map();
  for (const [id, rel] of pkg.relsOf(part)) {
    if (rel.mode === "External") {
      map.set(id, { ...rel });
      continue;
    }
    const t = pkg.targetOf(part, rel.target);
    if (/package|oleObject|workbook|embeddings|xlsx/i.test(rel.type) && pkg.parts.has(t)) {
      map.set(id, { ...rel, target: posix3.relative(dir, copyPart(pkg, t, mapped)) });
    } else map.set(id, { ...rel });
  }
  if (map.size > 0) pkg.rels.set(target, map);
  return target;
}
var CONTENT_REL = /\/(image|media|video|audio|chart|oleObject|package|diagramData|diagramLayout|diagramColors|diagramQuickStyle|drawing|hyperlink)$/;
function pptxClean(pkg, { dryRun = false } = {}) {
  const removed = [];
  for (const [owner, map] of [...pkg.rels]) {
    if (!pkg.parts.has(owner)) continue;
    const xml = pkg.get(owner) ?? Buffer.alloc(0);
    for (const [id, rel] of [...map]) {
      if (rel.mode !== "Internal" || !CONTENT_REL.test(rel.type)) continue;
      if (!xml.includes(`"${id}"`) && !xml.includes(`'${id}'`)) map.delete(id);
    }
  }
  const listed = new Set(pkg.parts.has("ppt/presentation.xml") ? deckOrder(pkg).map((e) => e.part) : []);
  for (const part of slideParts(pkg)) {
    if (!listed.has(part)) {
      removed.push(part);
      if (!dryRun) pkg.remove(part);
    }
  }
  const reachable = /* @__PURE__ */ new Set(["[Content_Types].xml"]);
  const queue = [""];
  while (queue.length) {
    const owner = queue.pop();
    for (const rel of pkg.relList(owner)) {
      if (rel.mode === "External") continue;
      const target = pkg.targetOf(owner, rel.target);
      if (!reachable.has(target) && pkg.parts.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  for (const name of [...pkg.parts.keys()]) {
    if (name.endsWith(".rels")) continue;
    if (!reachable.has(name)) {
      removed.push(name);
      if (!dryRun) pkg.remove(name);
    }
  }
  if (!dryRun) {
    for (const [owner, map] of [...pkg.rels]) {
      if (owner !== "" && !pkg.parts.has(owner)) {
        pkg.rels.delete(owner);
        continue;
      }
      for (const [id, rel] of [...map]) {
        if (rel.mode !== "External" && !pkg.parts.has(pkg.targetOf(owner, rel.target))) map.delete(id);
      }
    }
    for (const part of [...pkg.overrides.keys()]) if (!pkg.parts.has(part)) pkg.overrides.delete(part);
    const used = /* @__PURE__ */ new Set();
    for (const [owner] of pkg.rels) for (const rel of pkg.relList(owner)) used.add(pkg.targetOf(owner, rel.target));
    for (const name of [...pkg.parts.keys()]) {
      if (/^(ppt|word|xl)\/media\//.test(name) && !used.has(name)) {
        removed.push(name);
        pkg.remove(name);
      }
    }
  }
  return { removed: [...new Set(removed)], check: dryRun ? void 0 : checkPackage(pkg).length };
}

// src/office/xlsx.js
var DATE_FORMATS = /* @__PURE__ */ new Set([14, 15, 16, 17, 22, 45, 46, 47]);
var dateLike = (code) => /(^|[^\\])[ymdhs]/i.test(code ?? "");
function numFmts(pkg) {
  const map = /* @__PURE__ */ new Map();
  if (!pkg.parts.has("xl/styles.xml")) return map;
  const doc = pkg.xml("xl/styles.xml");
  const cellXfs = firstOf(doc.documentElement, "cellXfs");
  const custom = /* @__PURE__ */ new Map();
  for (const f of elementsOf(doc.documentElement, "numFmt")) custom.set(Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") ?? "");
  let i = 0;
  for (const xf of childrenOf(cellXfs)) {
    const id = Number(xf.getAttribute("numFmtId") ?? 0);
    map.set(i++, DATE_FORMATS.has(id) || dateLike(custom.get(id)) ? "date" : void 0);
  }
  return map;
}
function sharedStrings(pkg) {
  if (!pkg.parts.has("xl/sharedStrings.xml")) return [];
  return elementsOf(pkg.xml("xl/sharedStrings.xml").documentElement, "si").map((si) => textOf(si));
}
function sheetList(pkg) {
  const wb = pkg.xml("xl/workbook.xml");
  const rels = pkg.relsOf("xl/workbook.xml");
  return childrenOf(firstOf(wb.documentElement, "sheets") ?? wb.documentElement, "sheet").map((s) => {
    const rel = rels.get(s.getAttribute("r:id"));
    return { name: s.getAttribute("name"), state: s.getAttribute("state") ?? "visible", part: rel && pkg.targetOf("xl/workbook.xml", rel.target) };
  });
}
var colOf = (ref) => /^([A-Z]+)/.exec(ref)[1];
var rowOf = (ref) => Number(/(\d+)$/.exec(ref)[1]);
var colNum = (col) => [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
function dateEpoch(pkg) {
  const wb = pkg.parts.has("xl/workbook.xml") ? pkg.xml("xl/workbook.xml") : void 0;
  return /^(1|true)$/i.test(firstOf(wb?.documentElement, "workbookPr")?.getAttribute("date1904") ?? "") ? 24107 : 25569;
}
function cellValue(c, shared, fmt, epoch = 25569) {
  const t = c.getAttribute("t"), v = firstOf(c, "v"), f = firstOf(c, "f");
  let value = v == null ? void 0 : v.textContent;
  if (t === "s" && value !== void 0) value = shared[Number(value)] ?? `#SST${value}`;
  else if (t === "b") value = value === "1";
  else if (t === "str" || t === "inlineStr") value = t === "inlineStr" ? textOf(firstOf(c, "is") ?? c) : value;
  else if (t === "e") value = value;
  else if (value !== void 0 && fmt.get(Number(c.getAttribute("s") ?? 0)) === "date" && !Number.isNaN(Number(value))) {
    const days = Number(value) - epoch;
    value = new Date(days * 864e5).toISOString().slice(0, value.includes(".") ? 19 : 10);
  }
  return { value, formula: f?.textContent };
}
function xlsxInventory(pkg) {
  const wb = pkg.xml("xl/workbook.xml");
  const names = [];
  const dn = firstOf(wb.documentElement, "definedNames");
  for (const d of childrenOf(dn, "definedName")) {
    names.push({ name: d.getAttribute("name"), scope: d.getAttribute("localSheetId"), value: d.textContent });
  }
  const sheets = sheetList(pkg).map((s) => {
    if (!s.part || !pkg.parts.has(s.part)) return { ...s, missing: true };
    const doc = pkg.xml(s.part);
    const dim = firstOf(doc.documentElement, "dimension")?.getAttribute("ref");
    const cells = elementsOf(doc.documentElement, "c");
    const errors = cells.filter((c) => c.getAttribute("t") === "e").map((c) => ({ cell: c.getAttribute("r"), value: firstOf(c, "v")?.textContent, formula: firstOf(c, "f")?.textContent }));
    const uncached = cells.filter((c) => firstOf(c, "f") && !firstOf(c, "v")).length;
    const tables = pkg.relList(s.part).filter((r) => r.type.endsWith("/table")).length;
    const charts = pkg.relList(s.part).filter((r) => r.type.endsWith("/chart") || r.type.endsWith("/drawing")).length;
    return {
      ...s,
      dimension: dim,
      cells: cells.length,
      formulas: cells.filter((c) => firstOf(c, "f")).length,
      merged: childrenOf(firstOf(doc.documentElement, "mergeCells"), "mergeCell").length,
      tables,
      drawings: charts,
      errors,
      uncachedFormulas: uncached || void 0
    };
  });
  return { sheets, definedNames: names };
}
function xlsxRead(pkg, sheetName, range) {
  const sheet = sheetList(pkg).find((s) => s.name === sheetName);
  if (!sheet) {
    const e = new Error(`no sheet named ${sheetName}`);
    e.code = "args";
    throw e;
  }
  if (!pkg.parts.has(sheet.part)) {
    const e = new Error(`sheet part ${sheet.part} missing`);
    e.code = "args";
    throw e;
  }
  const shared = sharedStrings(pkg);
  const fmt = numFmts(pkg);
  const epoch = dateEpoch(pkg);
  const doc = pkg.xml(sheet.part);
  const inRange = (ref) => {
    if (!range) return true;
    const [lo, hi] = range.split(":");
    const [c, r] = [colNum(colOf(ref)), rowOf(ref)];
    return c >= colNum(colOf(lo)) && c <= colNum(colOf(hi ?? lo)) && r >= rowOf(lo) && r <= rowOf(hi ?? lo);
  };
  const rows = [];
  for (const row of elementsOf(doc.documentElement, "row")) {
    const cells = {};
    for (const c of childrenOf(row, "c")) {
      const ref = c.getAttribute("r");
      if (!inRange(ref)) continue;
      const { value, formula } = cellValue(c, shared, fmt, epoch);
      cells[ref] = formula ? { v: value, f: formula } : { v: value };
    }
    if (Object.keys(cells).length > 0) rows.push({ row: Number(row.getAttribute("r")), cells });
  }
  return { sheet: sheetName, range, rows };
}

// src/office/png.js
import { deflateSync, inflateSync } from "node:zlib";
function fail3(message) {
  const error = new Error(message);
  error.code = "png";
  throw error;
}
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 2303741511 || buf.readUInt32BE(4) !== 218765834) fail3("not a PNG file");
  let width, height, depth, color, interlace;
  let palette, trns;
  const idat = [];
  for (let pos = 8; pos < buf.length; ) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8) fail3(`PNG bit depth ${depth} unsupported (8 only)`);
  if (interlace !== 0) fail3("interlaced PNG unsupported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (channels === void 0) fail3(`PNG color type ${color} unsupported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0, pos = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v = v + a & 255;
      else if (filter === 2) v = v + b & 255;
      else if (filter === 3) v = v + (a + b >> 1) & 255;
      else if (filter === 4) v = v + paeth(a, b, c) & 255;
      else if (filter !== 0) fail3(`PNG filter ${filter} unsupported`);
      cur[x] = v;
    }
    pos += stride;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (color === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = 255;
    } else if (color === 2) {
      rgba.set(out.subarray(s, s + 3), d);
      rgba[d + 3] = 255;
    } else if (color === 3) {
      const idx = out[s];
      rgba[d] = palette[idx * 3];
      rgba[d + 1] = palette[idx * 3 + 1];
      rgba[d + 2] = palette[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (color === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = out[s + 1];
    } else rgba.set(out.subarray(s, s + 4), d);
  }
  return { width, height, data: rgba };
}
var paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
function encodePng({ width, height, data, channels = 4 }) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * channels;
      raw.set(data.subarray(s, s + 3), y * (stride + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, payload) => {
    const buf = Buffer.alloc(12 + payload.length);
    buf.writeUInt32BE(payload.length, 0);
    buf.write(type, 4, "latin1");
    payload.copy(buf, 8);
    buf.writeUInt32BE(crc322(buf.subarray(4, 8 + payload.length)), 8 + payload.length);
    return buf;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
var TABLE2 = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c;
  }
  return t;
})();
var crc322 = (buf) => {
  let c = ~0;
  for (const b of buf) c = TABLE2[(c ^ b) & 255] ^ c >>> 8;
  return ~c >>> 0;
};
var DIGITS = {
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 6, 8, 16, 31],
  "3": [14, 17, 1, 6, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12]
};
function drawLabel(img, x, y, text, scale = 1) {
  let cx = x;
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (!(glyph[row] & 16 >> col)) continue;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            const px = cx + col * scale + dx, py = y + row * scale + dy;
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
            const o = (py * img.width + px) * 4;
            img.data[o] = img.data[o + 1] = img.data[o + 2] = 40;
            img.data[o + 3] = 255;
          }
        }
      }
    }
    cx += 6 * scale;
  }
}
function contactSheet(images, { cols = 4, width = 320 } = {}) {
  const labelH = 10;
  const tiles = images.map((img) => {
    const h = Math.max(1, Math.round(img.height * width / img.width));
    return { img, h };
  });
  const rows = Math.ceil(tiles.length / cols);
  const rowH = [];
  for (let r = 0; r < rows; r++) rowH.push(Math.max(...tiles.slice(r * cols, (r + 1) * cols).map((t) => t.h), 1));
  const sheetW = cols * width;
  const sheetH = rowH.reduce((a, b) => a + b + labelH, 0);
  const data = Buffer.alloc(sheetW * sheetH * 4, 255);
  const sheet = { width: sheetW, height: sheetH, data, channels: 4 };
  let ty = 0;
  tiles.forEach((tile, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const y0 = ty;
    if (col === 0) ty = y0;
    const dstX = col * width, dstY = rowBaseline(rowH, row);
    for (let y = 0; y < tile.h; y++) {
      const sy = Math.floor(y * tile.img.height / tile.h);
      for (let x = 0; x < width; x++) {
        const sx = Math.floor(x * tile.img.width / width);
        const s = (sy * tile.img.width + sx) * 4, d = ((dstY + y) * sheetW + dstX + x) * 4;
        data.set(tile.img.data.subarray(s, s + 4), d);
      }
    }
    drawLabel(sheet, dstX + 2, dstY + tile.h + 1, String(i + 1), 1);
    ty = dstY;
  });
  return sheet;
}
var rowBaseline = (rowH, row) => rowH.slice(0, row).reduce((a, b) => a + b + 10, 0);

// src/office/cli.js
var USAGE = `ds-bot office — inspect, check and edit .docx/.pptx/.xlsx

unpack <file> <dir>                        extract with pretty-printed XML (new or reused dir)
pack <dir> <file> [--against <orig>]       repack (strips formatting whitespace) and check
check <file|dir> [--against <orig>] [--fix [-o out|--in-place]]
docx read <file> [--changes]               body blocks p1…/t1…, headers, notes, comments
docx fields <file>                         simple and complex fields
docx edit <file> -o out|--in-place --ops <json|@file>
pptx inventory <file|dir> [--slides N…|slideN.xml]
pptx layout <file> [--slides …] [--autofit (-o|--in-place)]
pptx slides <file> -o|--in-place --order 3,1,1,5
pptx clean <file|dir> [-o|--in-place] [--dry-run]
xlsx inventory <file>
xlsx read <file> --sheet <name> [--range A1:H40]
sheet <png…|dir> -o <contact.png> [--cols 4] [--width 320]`;
var JSON_MODE = false;
var Usage = class extends Error {
  constructor(m) {
    super(m);
    this.code = "usage";
  }
};
var need = (cond, message) => {
  if (!cond) throw new Usage(message);
};
function openAny(path) {
  return statSync2(path).isDirectory() ? Package.loadDir(path) : Package.open(path);
}
function outArgs(values, input) {
  if (values["in-place"]) return input;
  need(values.o !== void 0, "an edit writes to -o <file> or --in-place");
  return values.o;
}
var natural = (a, b) => a.localeCompare(b, void 0, { numeric: true });
async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      o: { type: "string" },
      "in-place": { type: "boolean" },
      against: { type: "string" },
      fix: { type: "boolean" },
      changes: { type: "boolean" },
      ops: { type: "string" },
      slides: { type: "string", multiple: true },
      autofit: { type: "boolean" },
      order: { type: "string" },
      "dry-run": { type: "boolean" },
      sheet: { type: "string" },
      range: { type: "string" },
      cols: { type: "string", default: "4" },
      width: { type: "string", default: "320" }
    }
  });
  JSON_MODE = values.json;
  const [cmd, sub, ...rest] = positionals;
  const positional = sub !== void 0 && ["read", "fields", "edit", "inventory", "layout", "slides", "clean"].includes(sub) ? rest : [sub, ...rest];
  const file = positional[0];
  const command = ["unpack", "pack", "check", "docx", "pptx", "xlsx", "sheet"].includes(cmd) ? cmd : void 0;
  need(command !== void 0 && file !== void 0 || cmd === "sheet" && file !== void 0, USAGE);
  if (command === "unpack") {
    need(positional[1], "unpack <file> <dir>");
    Package.open(file).unpack(positional[1]);
    return { dir: positional[1] };
  }
  if (command === "pack") {
    const dir = file, target = positional[1];
    need(target, "pack <dir> <file>");
    const pkg2 = Package.loadDir(dir);
    for (const name of pkg2.parts.keys()) {
      if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
      try {
        const doc = pkg2.xml(name);
        stripPrettyWhitespace(doc);
        pkg2.putXml(name, doc);
      } catch {
      }
    }
    writeFileSync2(target, pkg2.save());
    const against = values.against ? Package.open(values.against) : void 0;
    const findings = checkPackage(pkg2, against);
    return findings.length > 0 ? findingsResult(findings) : { file: target };
  }
  if (command === "check") {
    const pkg2 = openAny(file);
    if (values.fix) {
      const { fixed, remaining } = fixPackage(pkg2);
      const out = outArgs(values, file);
      if (statSync2(file).isDirectory()) pkg2.unpack(out);
      else writeFileSync2(out, pkg2.save());
      return remaining.length > 0 ? findingsResult(remaining, { fixed }) : { fixed, findings: [] };
    }
    const against = values.against ? openAny(values.against) : void 0;
    const findings = checkPackage(pkg2, against);
    return findings.length > 0 ? findingsResult(findings) : { findings: [] };
  }
  need(file && existsSync2(file), `no such file: ${String(file)}`);
  const pkg = ["docx", "pptx", "xlsx"].includes(command) ? openAny(file) : void 0;
  if (command === "docx") {
    if (sub === "read") return docxRead(pkg, { changes: values.changes });
    if (sub === "fields") return docxFields(pkg);
    if (sub === "edit") {
      need(values.ops, "docx edit needs --ops <json|@file>");
      const ops = JSON.parse(values.ops.startsWith("@") ? readFileSync2(values.ops.slice(1), "utf8") : values.ops);
      const result = docxEdit(pkg, ops);
      const out = outArgs(values, file);
      writeFileSync2(out, pkg.save());
      return { file: out, ...result };
    }
    throw new Usage("docx read|fields|edit");
  }
  if (command === "pptx") {
    if (sub === "inventory") return pptxInventory(pkg, values.slides);
    if (sub === "layout") {
      const result = pptxLayout(pkg, values.slides, { autofit: values.autofit });
      if (values.autofit && result.autofitApplied.length > 0) {
        const out = outArgs(values, file);
        writeFileSync2(out, pkg.save());
        result.file = out;
      }
      return result.findings.length > 0 ? findingsResult(result.findings, result) : result;
    }
    if (sub === "slides") {
      need(values.order, "pptx slides needs --order 3,1,1,5");
      const out = outArgs(values, file);
      const order = values.order.split(",").map((s) => Number(s.trim()));
      const result = pptxSlides(pkg, order);
      writeFileSync2(out, pkg.save());
      return { file: out, ...result };
    }
    if (sub === "clean") {
      const dry = values["dry-run"];
      const result = pptxClean(pkg, { dryRun: dry });
      if (!dry) {
        const out = outArgs(values, file);
        if (statSync2(file).isDirectory()) pkg.unpack(out);
        else writeFileSync2(out, pkg.save());
        result.file = out;
      }
      return result;
    }
    throw new Usage("pptx inventory|layout|slides|clean");
  }
  if (command === "xlsx") {
    if (sub === "inventory") return xlsxInventory(pkg);
    if (sub === "read") {
      need(values.sheet, "xlsx read needs --sheet <name>");
      return xlsxRead(pkg, values.sheet, values.range);
    }
    throw new Usage("xlsx inventory|read");
  }
  if (command === "sheet") {
    const inputs = positional.flatMap((p) => statSync2(p).isDirectory() ? readdirSync2(p).filter((n) => /\.png$/i.test(n)).sort(natural).map((n) => join2(p, n)) : [p]);
    need(inputs.length > 0 && values.o, "sheet <png…|dir> -o <contact.png>");
    const images = inputs.map((p) => decodePng(readFileSync2(p)));
    const sheetImg = contactSheet(images, { cols: Number(values.cols), width: Number(values.width) });
    mkdirSync2(join2(values.o, ".."), { recursive: true });
    writeFileSync2(values.o, encodePng(sheetImg));
    return { file: values.o, pages: images.length, width: sheetImg.width, height: sheetImg.height };
  }
  throw new Usage(USAGE);
}
function findingsResult(findings, extra = {}) {
  return { __findings: true, findings, ...extra };
}
main(process.argv.slice(2)).then((result) => {
  if (JSON_MODE) {
    const data = result?.__findings ? omit(result, ["__findings"]) : result;
    console.log(JSON.stringify({ ok: true, data }));
    process.exit(result?.__findings ? 1 : 0);
  }
  if (result?.__findings) {
    for (const f of result.findings) console.log(`${f.part}: ${f.message}`);
    process.exit(1);
  }
  console.log(typeof result === "string" ? result : JSON.stringify(result));
  process.exit(0);
}, (error) => {
  if (JSON_MODE) console.log(JSON.stringify({ ok: false, error: { code: error.code ?? "error", message: error.message } }));
  else console.error(error instanceof Usage ? `${error.message}
${USAGE}` : `office: ${error.message}`);
  process.exit(2);
});
var omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
