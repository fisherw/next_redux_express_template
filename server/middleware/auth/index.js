// var _ = require('underscore');
var resProcessor = require('../../components/res-processor');
var conf = require('../../conf');

var sessionTimeout = conf.redisExpire || 60 * 60 * 0.5;

/**
 * 在路由中添加require方法确保用户登录验证。
 * @param  {Object} options 配置项。配置如下：
 *     options.failureRedirect  String/Fuction   验证失败时跳转的页面路由或执行的路由方法, 若不配置，则不论验证是否成功，均放行
 * @return {function}        路由方法
 */
var required = function(opts) {
    var options = opts || {};
    options = Object.assign(
        {
            // session缓存时间（默认采用conf中配置的redisExpire,和redis3xSession中间件中的过期时间保持一致）
            expires: sessionTimeout,
            // 校验失败处理路由
            failureProcess: defaultFailureProcessor,
            // 检验是否登录方法
            isLogined: defaultIsLoginedProcessor
        },
        options
    );

    //中间处理程序: 在req中添加isAuthenticated，logout方便后边中间件使用。 同时做是否通过登录校验判断
    return function(req, res, next) {
        req.rSession = req.rSession || {};

        // 是否已验证
        req.isAuthenticated = function() {
            return this.rSession && this.rSession.user && this.rSession.user.id;
        };

        // 退出登录
        req.logout = function(redirectTo) {
            this.rSession.user = null;
            this.rSession.expires = 0;
            res.redirect(redirectTo);
        };

        // 已验证通过
        if (options.isLogined(req, res)) {
            next();

            // 重定向到指定（登录）页面
        } else {
            _routeProcess(req, res, next, options.failureProcess);
        }
    };
};

/**
 * 退出登录方法
 * @Author   fisher<wangjiang.fly.1989@163.com>
 * @DateTime 2016-12-13T14:47:13+0800
 * @param    {[type]}                           req [description]
 * @return   {[type]}                               [description]
 */
function logout(req, res, redirectTo) {
    req.rSession.user = null;
    req.rSession.expires = 0;
    res.redirect(redirectTo);
}

/**
 * 在路由中添加该方法进行用户登录验证
 * @param  {Object} options 配置项
 *     options.checkUser         Function         验证用户方法引用，必填。
 *         方法声明：
 *         options.checkUser = function (username, password, req, res, done) {
 *             // username 取req.body.username
 *             // password 取req.body.password
 *
 *             // done为回调方法:
 *             // done(null, user); // 验证成功，返回user实体对象
 *             // done(null, null); // 验证失败，返回空
 *             // done(err, null); // 验证失败，验证接口错误
 *         }
 *     options.expires    Number           session失效时间，单位秒（s)，选填，默认采用conf中配置的redisExpire,和redis3xSession中间件中的过期时间保持一致
 *     options.successRedirect   String           验证成功时的跳转路由字符串。可选，若配置，则跳转到该路由，否则继续执行
 *     options.failureRedirect   String/Function  验证失败时的跳转路由字符串或方法。 若不配置，则不论验证是否通过，均放行
 * @return {[type]}         [description]
 */
var validate = function(opts) {
    var options = opts || {};

    options = Object.assign(
        {
            // session缓存时间（默认采用conf中配置的redisExpire,和redis3xSession中间件中的过期时间保持一致）
            expires: sessionTimeout,
            // 验证失败处理路由
            failureRedirect: defaultFailureProcessor,
            // 验证用户方法
            checkUser: null
            // 检验是否登录方法
            //isLogined: defaultIsLoginedProcessor
        },
        options
    );

    if (!options.checkUser) {
        throw Error('auth middleware args error, options.checkUser function is necessary!');
    }

    return function(req, res, next) {
        req.rSession = req.rSession || {};
        var username = (req.body.username || '').trim();
        var password = (req.body.password || '').trim();
        var captcha = (req.body.captcha || '').trim();

        // // 已验证通过，并且在登录有效期内的话再次登录时只校验用户名不校验密码
        // if (options.isLogined(req, res)) {
        //     // 有配置验证成功后的目标路由
        //     if (options.successRedirect) {
        //         _routeProcess(req, res, next, options.successRedirect);
        //     } else {
        //         next();
        //     }

        //     // 需要验证
        // } else {

        // 配置了验证码登录
        if (options.needCapchaLoginTimes) {
            req.rSession.needCapchaLogin = true;
            // 达到验证码验证的登录次数，进行验证码验证
            if (req.rSession.failLoginTimes && req.rSession.failLoginTimes > options.needCapchaLoginTimes) {
                // 验证失败 req.rSession.captcha 在captcha路由中设置
                if (!req.rSession.captcha || captcha.toLowerCase() !== req.rSession.captcha.code.toLowerCase()) {
                    res.json({
                        data: { needCapchaLogin: true },
                        state: {
                            code: 100001,
                            msg: '验证码错误！'
                        }
                    });
                    return;
                }
            }
        }
        options.checkUser(username, password, req, res, function(err, user, state) {
            //java error返回
            if (err) {
                // req.tipMessage = '服务器错误';
                console.error('[验证用户失败]username:%s password:%s', username, password);
                console.error(err);
                deliverRouteProcess(err, req, res, next, state);
                //_routeProcess(req, res, next, options.failureRedirect);
                return;
            }

            // 验证成功
            if (user && user.id) {
                // 保存session
                updateAuthUserSession(req, res, user, options);

                // 有配置验证成功后的目标路由
                deliverRouteProcess(null, req, res, next, state);
                //_routeProcess(req, res, next, options.successRedirect);

                // 清空session记录的登录回跳地址
                req.rSession._loginRedirectUrl = null;

                // 验证失败
            } else {
                req.rSession.failLoginTimes += 1;
                deliverRouteProcess(null, req, res, next, state);
                //_routeProcess(req, res, next, options.failureRedirect);
            }
        });
    };
};
//};

/**
 * 更新(保存)用户登录session
 * @Author   fisher<wangjiang.fly.1989@163.com>
 * @DateTime 2016-08-08T17:46:52+0800
 * @param    {[type]}       req  [description]
 * @param    {[type]}       res  [description]
 * @param    {[type]}       user [description]
 * @param    {[type]}    options [description]
 * @return   {[type]}            [description]
 */
function updateAuthUserSession(req, res, user, options) {
    req.rSession = req.rSession || {};

    if (req.rSession && req.rSession.user) {
        user = Object.assign({}, req.rSession.user, user);
    }

    // 保存user
    req.rSession.user = User.create(req.rSession, user);

    // 设置session过期时间
    req.rSession.expires = req.rSession.expires || (options && options.expires) || sessionTimeout;

    // 写id到到cookie中，方便日志采集
    if (user && user.id) {
        res.cookie('idd', user.id, {
            //maxAge: 0, //expires * 1000,
            // httpOnly: true
        });
    }
}

/**
 * 默认检验用户是否登录方法
 * @Author   fisher<wangjiang.fly.1989@163.com>
 * @DateTime 2016-11-28T14:41:39+0800
 * @param    {[type]}                           req [description]
 * @param    {[type]}                           res [description]
 * @return   {[type]}                               [description]
 */
function defaultIsLoginedProcessor(req, res) {
    req.rSession = req.rSession || {};
    var rs = req.rSession,
        username = (req.body.username || '').trim(),
        password = (req.body.password || '').trim();

    return rs.user && ((username && rs.user.username === username) || !username);
}

/**
 * 默认验证失败处理路由
 * @param  {[type]}   req     [description]
 * @param  {[type]}   res     [description]
 * @param  {Function} next    [description]
 * @param  {[type]}   options [description]
 * @return {[type]}           [description]
 */
function defaultFailureProcessor(req, res, next, options) {
    var path = req.path,
        isPage = path.indexOf('/api/go/') > -1 || path.indexOf('/page/') > -1 ? true : false,
        isApi = path.indexOf('/api/') > -1 ? true : false;

    // 提示页面
    if (isPage) {
        var htmlContent = '<html><head><title>提示页面</title></head><body><h1>您访问的页面已过期！</h1></body></html>';
        resProcessor.forbidden(req, res, htmlContent);

        // 接口提示
    } else if (isApi) {
        resProcessor.ok(req, res, {data:null,state: {code: 91100, msg: '登录已过期！'}});
        // 其它情况
    } else {
        resProcessor.forbidden(req, res);
    }
}

/**
 * 路由处理
 * @param  {Object}   req  [description]
 * @param  {Object}   res  [description]
 * @param  {Function} next [description]
 * @param  {String/Function}   des  为字符串时，作重定向跳转到字符串对应路由，为方法时，则路由交由方法处理，否则执行next
 * @return {[type]}        [description]
 */
function _routeProcess(req, res, next, des) {
    if ('string' === typeof des) {
        res.redirect(des);
    } else if ('function' === typeof des) {
        des(req, res, next);
    } else {
        next();
    }
}

/**
 * 用户校验完成后的路由处理：以JSON形式返回给前端，让前端来处理
 * @param  {Object}   req  [description]
 * @param  {Object}   res  [description]
 * @param  {Function} next [description]
 * @param  {String/Function}   des  为字符串时，作重定向跳转到字符串对应路由，为方法时，则路由交由方法处理，否则执行next
 * @return {[type]}        [description]
 */
function deliverRouteProcess(err, req, res, next, state) {
    if (err) return res.send('Bad Request');
    req.userState = state;
    next();
}

/**
 * 用户类封装
 * 用户类User包含以下基本属性（可扩展）
 * username  String  用户名
 * password  String  登录密码
 * type      String  用户类型
 *
 * @param {[type]} ctx     [description]
 * @param {[type]} options [description]
 */
var User = function(ctx, options) {
    Object.defineProperty(this, '_ctx', {
        value: ctx
    });

    if (options) {
        for (var key in options) {
            this[key] = options[key];
        }
    }
};

/**
 * 工厂方法，生成User实例
 * @param  {RSession} rSession 上下文对象
 * @param  {Object} obj      user属性配置
 * @return {User}          User实例
 */
User.create = function(rSession, obj) {
    var ctx = new UserContext(rSession);

    return new User(ctx, obj);
};

/**
 * 序列化User对象
 * @param  {User} rs
 * @return {String}    rs序列化后的字符串
 */
User.serialize = function(rs) {
    return encode(rs);
};

/**
 * 反序列化User对象
 * @param  {RSession} rSession 上下文对象
 * @param  {String}  str      序列化的字符串
 * @return {User}          User实例
 */
User.deserialize = function(rSession, str) {
    var ctx = new UserContext(rSession),
        obj = decode(str);

    // 标识非新建（由反序列化得到）
    ctx._new = false;

    // 存放User序列化串
    ctx._val = str;

    return new User(ctx, obj);
};

/**
 * UserContext类封装
 * @param {Context} rSesson ctx对象
 */
var UserContext = function(rSession) {
    this.rs = rSession;
    this._new = true;
    this._val = undefined;
};

module.exports.required = required;
module.exports.validate = validate;
module.exports.updateAuthUserSession = updateAuthUserSession;
module.exports.logout = logout;
